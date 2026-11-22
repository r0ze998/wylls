//! PLOAD (herald-load-50, TEST/local only): P7's devnet stack — the herald in its devnet mode serving the page
//! (`--web`, `/gw/*` to the gateway's `--devnet-play` routes) and keeper A with the devnet roles, on the devnet `.so`
//! in the in-process local chain — HELD OPEN for an external load generator (headless pages and a replay of a page's
//! request mix, `~/Projects/wylls-grok-state/evidence/herald-load-50/scripts`).
//!
//! The test sends no player command. It makes `OPERATOR_LOAD_PLAYERS` (default 100) TEST wallets with 5 SOL each,
//! writes `$OPERATOR_LOAD_DIR/stack.json` (ports, program, Season, the opened rim provinces and their nations, the
//! wallets' seed files), then runs the chain clock at `OPERATOR_LOAD_SCALE` (default 5: a 600 s bell every 120 s of
//! wall time) and declares each finished bell's anchor and seed in every region (offline no drand round covers them;
//! on devnet keeper A's beacon role does this), until `$OPERATOR_LOAD_DIR/stop` exists or `OPERATOR_LOAD_MAX_SECS`
//! (default 7,200) pass. `$OPERATOR_LOAD_DIR/clock.jsonl` gets one line per declared bell.

use super::*;

pub(super) async fn flow(r: &mut Run<'_>, pg: &Page, plan: &[(i32, i32)], extra: Value) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let env_num = |k: &str, d: f64| {
        std::env::var(k)
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(d)
    };
    let dir = std::path::PathBuf::from(
        std::env::var("OPERATOR_LOAD_DIR").expect("PLOAD needs OPERATOR_LOAD_DIR"),
    );
    let pdir = dir.join("players");
    std::fs::create_dir_all(&pdir).unwrap();
    // (the season's own summary is written there after the hold; the other modes expect it made beforehand)
    if let Ok(e) = std::env::var("OPERATOR_EVIDENCE_DIR") {
        std::fs::create_dir_all(e).unwrap();
    }
    let n = env_num("OPERATOR_LOAD_PLAYERS", 100.0) as usize;
    let scale = env_num("OPERATOR_LOAD_SCALE", 5.0);
    let max_secs = env_num("OPERATOR_LOAD_MAX_SECS", 7_200.0) as u64;
    let a = r.c.a.clone();
    let sd = r.season();
    let regions = sd[S::REGIONS];
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let genesis_ts = r.clock().3;
    let provinces: Vec<Value> = plan
        .iter()
        .map(|&(p, q)| {
            let nation = home_nation(
                ProvinceCoord::new(p, q),
                cq.placement,
                cq.heartland_max_ring,
                &gseed,
            );
            let free: Vec<u8> = r
                .data(&a.province(p, q))
                .map(|pd| {
                    (0..pd[PV::SITE_COUNT] as usize)
                        .filter(|i| {
                            matches!(
                                pd[PV::site(*i) + SM::STATE],
                                SM::STATE_FREE | SM::STATE_RELEASED_FREE
                            )
                        })
                        .map(|i| i as u8)
                        .collect()
                })
                .unwrap_or_default();
            json!({"p": p, "q": q, "ring": ProvinceCoord::new(p, q).ring(), "nation": nation, "free_sites": free})
        })
        .collect();
    let mut players = vec![];
    for i in 0..n {
        let k = Keypair::new(); // TEST key, this chain only
        r.lock().airdrop(&k.pubkey(), 5 * SOL).unwrap();
        let f = pdir.join(format!("{i:03}.seed"));
        std::fs::write(&f, hex::encode(&k.to_bytes()[..32])).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        players.push(json!({"i": i, "wallet": k.pubkey().to_string(), "seed_file": f}));
    }
    let gw_pub = pg.herald - 5 + 7; // (playable_season: herald = base + 5, gateway public = base + 7)
    let info = json!({
        "herald": pg.herald, "gateway_public": gw_pub, "gateway_operator": gw_pub - 1,
        "page": format!("http://127.0.0.1:{}/frontier/frontier/", pg.herald),
        "program": r.c.program.to_string(), "season": a.season.to_string(), "season_id": SEASON_ID,
        "regions": regions, "genesis_ts": genesis_ts, "scale": scale, "provinces": provinces,
        "players": players, "setup": extra,
    });
    std::fs::write(
        dir.join("stack.json"),
        serde_json::to_vec_pretty(&info).unwrap(),
    )
    .unwrap();
    {
        let mut c = r.lock();
        c.set_scale(scale);
        c.set_paused(false);
    }
    let t0 = Instant::now();
    let mut declared_to: i64 = r.bell() as i64 - 1; // bells below this were the setup's
    let mut bells = 0u32;
    while !dir.join("stop").exists() && t0.elapsed() < Duration::from_secs(max_secs) {
        // a bell is declared once its anchor time (its end + 100 s) has passed, as page_flow does after its advance
        let now = r.now();
        let done = ((now - genesis_ts - 100) / 600 - 1).max(0);
        while declared_to < done {
            declared_to += 1;
            for region in 0..regions {
                r.stage_seed(
                    declared_to as u32,
                    region,
                    [(declared_to % 251) as u8 ^ 0x3C; 32],
                );
            }
            bells += 1;
            let line = json!({"wall_s": t0.elapsed().as_secs_f64(), "bell": declared_to, "chain_ts": now, "slot": r.lock().slot()});
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("clock.jsonl"))
                .unwrap();
            std::io::Write::write_all(&mut f, format!("{line}\n").as_bytes()).unwrap();
        }
        assert!(
            r.c.keeper.try_wait().ok().flatten().is_none(),
            "keeper A exited during the hold"
        );
        tokio::time::sleep(Duration::from_millis(1_000)).await;
    }
    r.lock().set_scale(1.0);
    json!({"pload": "held open", "wall_secs": t0.elapsed().as_secs(), "bells_declared": bells, "players": n})
}
