//! P9 (devnet-page-war): the web page as the war's participant. As P7, the page is served by the herald in its devnet
//! mode and sends through the gateway's devnet play routes, signed by a Wallet Standard TEST wallet on `solana:devnet`
//! (`page_war_driver.mjs`). The page: Join and its own rim village (its home planner), Harvest, **Muster**, ONE sealed
//! **Depart** onto the keep the test names (the page's own keep march card and 出発 button; the wallet signs; the seal
//! is the page's own time-lock to T(21)), a **reload** (its encrypted march book must survive), and its self-reveal
//! request to keeper A once T(21) is published. This test only moves the clock, declares the bells' anchors and seeds
//! (as P8) and the reserve; keeper A does everything else ([`super::keeper_war`]).
use super::*;
use fclient::decode::Holding;

fn sync_write(dir: &std::path::Path, name: &str, v: &Value) {
    std::fs::write(dir.join(name), v.to_string()).unwrap();
}

pub(super) async fn flow(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    nation: u8,
    war_plan: Value,
    extra: Value,
) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let a = r.c.a.clone();
    let regions = r.season()[S::REGIONS];
    let genesis_ts = r.clock().3;
    let sync = r.c.dir.join("page");
    std::fs::create_dir_all(&sync).unwrap();
    std::fs::create_dir_all(&pg.out).unwrap();
    let player = Keypair::new(); // TEST key: the page's wallet (this chain only)
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let seed_file = sync.join("player.seed");
    std::fs::write(&seed_file, hex::encode(&player.to_bytes()[..32])).unwrap();
    std::fs::set_permissions(&seed_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let mut driver = KillChild(
        std::process::Command::new("node")
            .arg(&pg.driver)
            .args([
                "--url",
                &format!("http://127.0.0.1:{}/frontier/frontier/", pg.herald),
                "--out",
                pg.out.to_str().unwrap(),
                "--seed-file",
                seed_file.to_str().unwrap(),
                "--nation",
                &nation.to_string(),
                "--inspect",
                &pg.inspect.to_string(),
                "--sync",
                sync.to_str().unwrap(),
            ])
            .stdout(std::fs::File::create(pg.out.join("driver.out.log")).unwrap())
            .stderr(std::fs::File::create(pg.out.join("driver.err.log")).unwrap())
            .spawn()
            .expect("node (the page war driver)"),
    );
    let citizen = a.citizen(&w);
    let alive = |d: &mut KillChild| d.0.try_wait().ok().flatten().is_none();
    // 1. The page Joins and files its rim ticket; declared anchor + seed of that bell in every region; keeper A settles.
    let t0 = Instant::now();
    let ticket_bell = loop {
        if let Some(cd) = r.data(&citizen) {
            let tb = le_u32(&cd, C::TICKET_BELL);
            if tb != C::NO_TICKET {
                break tb;
            }
        }
        assert!(alive(&mut driver), "the driver exited before the ticket");
        assert!(
            t0.elapsed() < Duration::from_secs(420),
            "the page did not file a rim ticket"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
    for region in 0..regions {
        r.stage_seed(ticket_bell, region, [0x5A; 32]);
    }
    let find_home = |r: &Run<'_>| -> Option<(i32, i32, u8, Address)> {
        for &(p, q) in plan {
            for s in 0..12u8 {
                let h = a.holding(p, q, s);
                if let Some(d) = r.data(&h) {
                    if d.len() > H::OWNER_CITIZEN + 32
                        && d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] == citizen.to_bytes()
                    {
                        return Some((p, q, s, h));
                    }
                }
            }
        }
        None
    };
    let mut beacon = Beacon {
        regions: (0..regions).collect(),
        staged: Default::default(),
        from_bell: 0,
    };
    drive(
        r,
        &mut beacon,
        2.0,
        300,
        "keeper A settles the page's rim ticket",
        |r| find_home(r).is_some(),
    )
    .await;
    let (hp, hq, site, holding) = find_home(r).unwrap();
    let joined_nation = r.data(&citizen).unwrap()[C::FACTION];
    let ((tp, tq), keep0, start, dirs) = keep_target(r, plan, (hp, hq), joined_nation)
        .unwrap_or_else(|| panic!("no contestable keep beside the page's village ({hp}, {hq}) of nation {joined_nation}"));
    let (hr, dr) = (ix::region_of(hp, hq), ix::region_of(tp, tq));
    let _ = (hr, dr);
    // PFOG (fog-devnet): two observers of other nations found their rim villages and open the page too
    let mut observers = if pg.fog {
        let a_tile = r.province_of(hp, hq).unwrap().sites[site as usize];
        Some(
            super::fog::setup(
                r,
                pg,
                plan,
                &mut beacon,
                &sync,
                (hp, hq, site, a_tile),
                joined_nation,
                (tp, tq),
                &keep0,
                start,
            )
            .await,
        )
    } else {
        None
    };
    // 2. Final: the page harvests at each new bell; the clock passes final_ts.
    let final_ts = le_i64(&r.data(&holding).unwrap(), H::FINAL_TS);
    let t_final = final_ts.max(r.now()) + 60;
    drive(
        r,
        &mut beacon,
        10.0,
        600,
        "the page's Harvest flips the rim village final",
        |r| {
            r.now() >= t_final
                && r.data(&holding)
                    .is_some_and(|d| d[H::STATE] == H::STATE_FINAL)
        },
    )
    .await;
    assert!(alive(&mut driver), "the driver exited while harvesting");
    // 3. Declared: the reserve; keeper A makes the home resident; the page musters.
    r.lock().set_paused(true);
    let mut hd = r.lock().account(&holding).unwrap();
    let ro = H::reserve(0);
    hd.data[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
    r.patch(
        holding,
        hd,
        &format!("{TROOPS} Spearmen in the page's rim village's reserve"),
    );
    drive(
        r,
        &mut beacon,
        10.0,
        600,
        "keeper A resolves the page's home province to the current bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    let h0 = Holding::decode(&r.data(&holding).unwrap()).unwrap();
    let host = fclient::addr::host_id(hp, hq, site, h0.gen, h0.host_seq).unwrap();
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    sync_write(
        &sync,
        "go-muster",
        &json!({"troops": TROOPS, "tile": start}),
    );
    let t0 = Instant::now();
    while !r
        .province_of(hp, hq)
        .is_some_and(|v| v.entries.iter().any(|e| e.id == host))
    {
        assert!(
            alive(&mut driver),
            "the driver exited before the muster landed"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(240),
            "the page's Muster did not land (host {host})"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let muster_bell = r.bell();
    assert!(
        muster_bell < DEPART_BELL,
        "the page mustered at bell {muster_bell}: too late for bell {DEPART_BELL}"
    );
    // 4. The Depart bell (the home kept resident), then the page's keep march.
    let depart_t = genesis_ts + 600 * DEPART_BELL as i64 + 30;
    // (fast to five minutes before the Depart bell, then slowly, so that the bell is not passed)
    drive(
        r,
        &mut beacon,
        40.0,
        1500,
        "five minutes before the Depart bell",
        |r| r.now() >= depart_t - 330,
    )
    .await;
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "the Depart bell, the home resident",
        |r| {
            assert!(
                r.bell() <= DEPART_BELL,
                "the Depart bell {DEPART_BELL} passed before the home was resident"
            );
            r.now() >= depart_t
                && r.province_of(hp, hq)
                    .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let since = r.lock().slot();
    sync_write(
        &sync,
        "go-march",
        &json!({"host": host.to_string(), "p": tp, "q": tq, "tile": keep0.tile, "arrive": ARRIVE_BELL}),
    );
    let t0 = Instant::now();
    while !Holding::decode(&r.data(&holding).unwrap())
        .is_ok_and(|h| h.transit[0].state == 1 && h.transit[0].host_id == host)
    {
        assert!(
            alive(&mut driver),
            "the driver exited before its Depart landed"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(420),
            "the page's Depart did not land"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let depart_bell = r.bell();
    assert_eq!(
        depart_bell, DEPART_BELL,
        "the page departed in bell {DEPART_BELL}"
    );
    let tr = Holding::decode(&r.data(&holding).unwrap()).unwrap().transit[0];
    assert_eq!(
        tr.arrive_bell, ARRIVE_BELL,
        "the page's march arrives at bell {ARRIVE_BELL}"
    );
    // (the reload: the driver says what its encrypted book held before and after)
    let t0 = Instant::now();
    while !sync.join("reloaded.json").exists() {
        assert!(alive(&mut driver), "the driver exited before its reload");
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the page did not reload"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let reloaded: Value =
        serde_json::from_str(&std::fs::read_to_string(sync.join("reloaded.json")).unwrap())
            .unwrap();
    let kept = |v: &Value| {
        v["entries"].as_array().is_some_and(|e| {
            e.iter().any(|x| {
                x["host"].as_str() == Some(host.to_string().as_str())
                    && x["arriveBell"] == ARRIVE_BELL
                    && x["hasPlain"] == true
            })
        })
    };
    assert!(
        kept(&reloaded["before"]) && kept(&reloaded["after"]),
        "the page's encrypted book must keep the march across the reload: {reloaded:#}"
    );
    assert_eq!(
        reloaded["after"]["plainLocalStorageEntries"], 0,
        "nothing of the book in plain localStorage: {reloaded:#}"
    );
    // (PFOG: A's march has left — what each player's page tells of it)
    if let Some(o) = observers.as_mut() {
        o.host(host);
        super::fog::snap(r, o, &mut beacon, "departed").await;
    }
    // 5. keeper A's war (the page asks keeper A to reveal once T(21) is out; keeper A may have opened it itself first).
    let war = keeper_war(
        r,
        &mut beacon,
        (hp, hq),
        (tp, tq),
        holding,
        host,
        joined_nation,
        since,
        observers.as_mut(),
    )
    .await;
    assert!(alive(&mut driver), "the driver exited during the war");
    // (PFOG: the last look, then the owner's fog rules over every snapshot)
    let fog = match observers.take() {
        Some(o) => {
            let v = super::fog::finish(r, o, &mut beacon, &pg.out).await;
            assert!(
                v["failures"].as_array().is_some_and(|f| f.is_empty()),
                "the fog of war on the devnet page: {:#}",
                json!({"failures": v["failures"], "checks": v["checks"], "plan": v["plan"], "table": v["table"]})
            );
            Some(json!({"checks": v["checks"], "failures": v["failures"], "plan": v["plan"], "table": v["table"]}))
        }
        None => None,
    };
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    sync_write(&sync, "go-final", &json!({"bell": r.bell()}));
    let t0 = Instant::now();
    let done = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("done.json")) {
            break serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        assert!(
            alive(&mut driver),
            "the driver exited before its last stills"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the page did not finish"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    drop(driver);
    let page_txs: Vec<Value> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            (t.message.account_keys.first() == Some(&w)).then(|| {
                json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "signatures": t.signatures.len(),
                       "tag": t.message.instructions.last().and_then(|i| i.data.first().copied()).map(|x| format!("0x{x:02X}")),
                       "compute_units": l.units, "fee": l.fee,
                       "lamports_from_wallet": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
            })
        })
        .collect();
    assert!(
        page_txs.iter().all(|x| x["signatures"] == 1),
        "{page_txs:#?}"
    );
    assert!(
        page_txs
            .iter()
            .any(|x| x["tag"] == format!("0x{:02X}", fclient::abi::tag::DEPART) && x["ok"] == true),
        "the page's Depart: {page_txs:#?}"
    );
    // (verify-pr118) the verifier judges the whole season: no FAIL
    let verifier = r.judge_season("p9");
    assert_eq!(
        verifier["fails"], 0,
        "the verifier FAILs the season: {verifier:#}"
    );
    json!({"verifier_season": verifier, "p9_page_war": "the web page's legacy war on the devnet .so: rim village, Muster, ONE sealed Depart onto a keep (wallet-signed, wallet-paid), its encrypted book across a reload; keeper A reveals, resolves, settles",
        "participant": {"wallet": w.to_string(), "nation": joined_nation},
        "village": {"p": hp, "q": hq, "site": site, "ticket_bell": ticket_bell, "final_ts": final_ts},
        "target": {"p": tp, "q": tq, "keep": format!("{keep0:?}"), "start_tile": start, "dirs": dirs},
        "muster_bell": muster_bell, "depart_bell": depart_bell, "reloaded": reloaded, "keeper_war": war,
        "page_transactions": page_txs, "driver": done, "declared_patches": r.patches, "plan_hint": war_plan, "setup": extra, "fog": fog})
}

// ------------------------------------------------------------------ P10 (devnet-page-war-2)

/// Counts the page's POSTs to `path` in the driver's request log.
fn posts(pg: &Page, path: &str) -> usize {
    std::fs::read_to_string(pg.out.join("devnet-play-requests.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| l.starts_with(&format!("POST {path}")))
        .count()
}

/// The page's own march book as the driver last wrote it (`<sync>/book.json`), or null.
fn book(sync: &std::path::Path) -> Value {
    std::fs::read_to_string(sync.join("book.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// The self-reveal attempts the page's book records for `host` arriving at `arrive`: `[(t, result)]`.
fn self_attempts(sync: &std::path::Path, host: u64, arrive: u32) -> Vec<(i64, String)> {
    let b = book(sync);
    b["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| {
            e["host"].as_str() == Some(host.to_string().as_str()) && e["arriveBell"] == arrive
        })
        .flat_map(|e| e["attempts"].as_array().cloned().unwrap_or_default())
        .filter(|a| a["route"] == "self")
        .map(|a| {
            (
                a["t"].as_f64().map_or(0, |t| t as i64),
                a["result"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

/// A shortest route inside province `home` over its passable tiles, from tile `from` to tile `goal`.
fn route_inside(home: (i32, i32), mask: u64, from: u8, goal: u8) -> Option<Vec<u8>> {
    use permutation_rules::frontier::geometry::locate;
    use permutation_rules::hex::{Hex, DIRECTIONS};
    use std::collections::{HashMap, VecDeque};
    let ok = |pc: (i32, i32), t: u8| pc == home && t < 61 && mask & (1u64 << t) != 0;
    let s = super::hex_of(home.0, home.1, from)?;
    let mut prev: HashMap<(i32, i32), Option<((i32, i32), u8)>> = HashMap::new();
    prev.insert((s.q, s.r), None);
    let mut queue = VecDeque::from([s]);
    while let Some(h) = queue.pop_front() {
        let (pc, t) = locate(h);
        if (pc.p, pc.q) == home && t == goal {
            let mut dirs = vec![];
            let mut cur = (h.q, h.r);
            while let Some(Some((from, d))) = prev.get(&cur) {
                dirs.push(*d);
                cur = *from;
            }
            dirs.reverse();
            return Some(dirs);
        }
        for d in 0..6u8 {
            let (dq, dr) = DIRECTIONS[d as usize];
            let n = Hex::new(h.q + dq, h.r + dr);
            let (npc, nt) = locate(n);
            if ok((npc.p, npc.q), nt) && !prev.contains_key(&(n.q, n.r)) {
                prev.insert((n.q, n.r), Some(((h.q, h.r), d)));
                queue.push_back(n);
            }
        }
    }
    None
}

/// The muster tile of the return march: a passable tile of the home province 2–3 steps from the village's tile (the
/// march home is a real, short path), else any other passable tile with a path. → `(tile, dirs to the village)`.
fn home_start(home: (i32, i32), mask: u64, village: u8) -> Option<(u8, Vec<u8>)> {
    let tiles: Vec<u8> = (0..61u8)
        .filter(|t| mask & (1u64 << t) != 0 && *t != village)
        .collect();
    let mut best: Option<(u8, Vec<u8>)> = None;
    for t in tiles {
        if let Some(d) = route_inside(home, mask, t, village) {
            let good = (2..=3).contains(&d.len());
            if good {
                return Some((t, d));
            }
            if best.is_none() && !d.is_empty() {
                best = Some((t, d));
            }
        }
    }
    best
}

/// Stops keeper A (the process this test started): its API and every duty are down until [`keeper_up`].
fn keeper_down(r: &mut Run<'_>) {
    let k = &mut *r.c.keeper;
    let _ = k.kill();
    let _ = k.wait();
}

/// Starts keeper A again: the same binary, config, journal and API port (it re-reads the chain's feed).
async fn keeper_up(r: &mut Run<'_>, o: &super::Outage, n: u32) {
    let log = |name: &str| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(r.c.dir.join(name))
            .unwrap()
    };
    let (out, err) = (log("keeper-restarted.out.log"), log("keeper-restarted.log"));
    use std::io::Write;
    let _ = writeln!(
        &err,
        "=== P10: keeper A restart {n} at chain {} (bell {})",
        r.now(),
        r.bell()
    );
    *r.c.keeper = std::process::Command::new(&o.keeper_bin)
        .args(["--config", o.keeper_config.to_str().unwrap()])
        .env("FRONTIER_KEEPER_TICK_LOG", "1")
        .stdout(out)
        .stderr(err)
        .spawn()
        .expect("frontier-keeper (restarted)");
    let api = r.c.war.as_ref().unwrap().keeper_api;
    let t0 = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", api)).is_err() {
        assert!(
            r.c.keeper.try_wait().ok().flatten().is_none(),
            "keeper A exited at restart {n}"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "keeper A's API did not come back (restart {n})"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Restarts drand-replay on its port with `args` (the full archive, or the one without T(21)).
async fn drand_restart(r: &mut Run<'_>, o: &super::Outage, args: &[String], what: &str) {
    {
        let d = &mut *r.c.drand;
        let _ = d.kill();
        let _ = d.wait();
    }
    let t0 = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", o.drand_port)).is_ok() {
        assert!(
            t0.elapsed() < Duration::from_secs(30),
            "drand-replay's port stayed taken"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let err = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(r.c.dir.join("drand-replay-restarted.log"))
        .unwrap();
    {
        use std::io::Write;
        let _ = writeln!(
            &err,
            "=== P10: drand-replay {what} at chain {} (bell {})",
            r.now(),
            r.bell()
        );
    }
    *r.c.drand = std::process::Command::new(&o.drand_bin)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(err)
        .spawn()
        .expect("drand-replay (restarted)");
    let t0 = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", o.drand_port)).is_err() {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "drand-replay did not listen again ({what})"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Runs the chain at `scale` WITHOUT asserting keeper A (it may be down on purpose), with the declared beacon kept up,
/// until `done` or `secs`.
async fn run_while(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    scale: f64,
    secs: u64,
    what: &str,
    mut done: impl FnMut(&Run<'_>) -> bool,
) {
    let t0 = Instant::now();
    loop {
        {
            let mut c = r.lock();
            c.set_scale(scale);
            c.set_paused(false);
        }
        beacon.tick(r);
        if done(r) {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(secs),
            "{what}: not reached in {secs} s (chain clock {}, bell {})",
            r.now(),
            r.bell()
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    r.lock().set_scale(1.0);
}

pub(super) async fn flow_home(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    war_plan: Value,
    extra: Value,
) -> Value {
    use fclient::abi::tag as T;
    use std::os::unix::fs::PermissionsExt;
    let o = r.c.war.as_ref().unwrap().outage.clone().unwrap();
    let (api, token) = {
        let w = r.c.war.as_ref().unwrap();
        (w.keeper_api, w.token.clone())
    };
    let a = r.c.a.clone();
    let regions = r.season()[S::REGIONS];
    let genesis_ts = r.clock().3;
    let sync = r.c.dir.join("page");
    std::fs::create_dir_all(&sync).unwrap();
    std::fs::create_dir_all(&pg.out).unwrap();
    let player = Keypair::new(); // TEST key: the page's wallet (this chain only)
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let seed_file = sync.join("player.seed");
    std::fs::write(&seed_file, hex::encode(&player.to_bytes()[..32])).unwrap();
    std::fs::set_permissions(&seed_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    // (any nation: the march stays at home; the war plan's nation is only a hint for the planner)
    let nation = war_plan["nation"].as_u64().unwrap_or(0) as u8;
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let mut driver = KillChild(
        std::process::Command::new("node")
            .arg(&pg.driver)
            .args([
                "--url",
                &format!("http://127.0.0.1:{}/frontier/frontier/", pg.herald),
                "--out",
                pg.out.to_str().unwrap(),
                "--seed-file",
                seed_file.to_str().unwrap(),
                "--nation",
                &nation.to_string(),
                "--inspect",
                &pg.inspect.to_string(),
                "--sync",
                sync.to_str().unwrap(),
                "--scenario",
                "home",
            ])
            .stdout(std::fs::File::create(pg.out.join("driver.out.log")).unwrap())
            .stderr(std::fs::File::create(pg.out.join("driver.err.log")).unwrap())
            .spawn()
            .expect("node (the page war driver)"),
    );
    let citizen = a.citizen(&w);
    let alive = |d: &mut KillChild| d.0.try_wait().ok().flatten().is_none();
    // 1. The page Joins and files its rim ticket (as P9).
    let t0 = Instant::now();
    let ticket_bell = loop {
        if let Some(cd) = r.data(&citizen) {
            let tb = le_u32(&cd, C::TICKET_BELL);
            if tb != C::NO_TICKET {
                break tb;
            }
        }
        assert!(alive(&mut driver), "the driver exited before the ticket");
        assert!(
            t0.elapsed() < Duration::from_secs(420),
            "the page did not file a rim ticket"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
    for region in 0..regions {
        r.stage_seed(ticket_bell, region, [0x5A; 32]);
    }
    let find_home = |r: &Run<'_>| -> Option<(i32, i32, u8, Address)> {
        for &(p, q) in plan {
            for s in 0..12u8 {
                let h = a.holding(p, q, s);
                if let Some(d) = r.data(&h) {
                    if d.len() > H::OWNER_CITIZEN + 32
                        && d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] == citizen.to_bytes()
                    {
                        return Some((p, q, s, h));
                    }
                }
            }
        }
        None
    };
    let mut beacon = Beacon {
        regions: (0..regions).collect(),
        staged: Default::default(),
        from_bell: 0,
    };
    drive(
        r,
        &mut beacon,
        2.0,
        300,
        "keeper A settles the page's rim ticket",
        |r| find_home(r).is_some(),
    )
    .await;
    let (hp, hq, site, holding) = find_home(r).unwrap();
    let joined_nation = r.data(&citizen).unwrap()[C::FACTION];
    // 2. Final (as P9).
    let final_ts = le_i64(&r.data(&holding).unwrap(), H::FINAL_TS);
    let t_final = final_ts.max(r.now()) + 60;
    drive(
        r,
        &mut beacon,
        10.0,
        1200,
        "the page's Harvest flips the rim village final",
        |r| {
            r.now() >= t_final
                && r.data(&holding)
                    .is_some_and(|d| d[H::STATE] == H::STATE_FINAL)
        },
    )
    .await;
    assert!(alive(&mut driver), "the driver exited while harvesting");
    // 3. Declared: the reserve (as P9); keeper A makes the home resident.
    r.lock().set_paused(true);
    let mut hd = r.lock().account(&holding).unwrap();
    let ro = H::reserve(0);
    hd.data[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
    r.patch(
        holding,
        hd,
        &format!("{TROOPS} Spearmen in the page's rim village's reserve"),
    );
    drive(
        r,
        &mut beacon,
        10.0,
        600,
        "keeper A resolves the page's home province to the current bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    let h0 = Holding::decode(&r.data(&holding).unwrap()).unwrap();
    let host = fclient::addr::host_id(hp, hq, site, h0.gen, h0.host_seq).unwrap();
    let village = h0.tile;
    let hv = r.province_of(hp, hq).unwrap();
    let (start, dirs) = home_start((hp, hq), hv.passable_mask, village).unwrap_or_else(|| {
        panic!("no passable tile of ({hp}, {hq}) with a path to the village tile {village}")
    });
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    sync_write(
        &sync,
        "go-muster",
        &json!({"troops": TROOPS, "tile": start}),
    );
    let t0 = Instant::now();
    while !r
        .province_of(hp, hq)
        .is_some_and(|v| v.entries.iter().any(|e| e.id == host))
    {
        assert!(
            alive(&mut driver),
            "the driver exited before the muster landed"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(240),
            "the page's Muster did not land (host {host})"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let muster_bell = r.bell();
    assert!(
        muster_bell < DEPART_BELL,
        "the page mustered at bell {muster_bell}: too late for bell {DEPART_BELL}"
    );
    // 4. OUTAGE A — the Depart bell with keeper A stopped: the home province cannot be resolved through bell 17 (its
    //    window closes at about 100 s into bell 19), so the page's read says NotResident for as long as keeper A is down.
    let depart_t = genesis_ts + 600 * DEPART_BELL as i64 + 20;
    drive(
        r,
        &mut beacon,
        40.0,
        1500,
        "five minutes before the Depart bell",
        |r| r.now() >= depart_t - 330,
    )
    .await;
    drive(r, &mut beacon, 2.0, 900, "the Depart bell", |r| {
        assert!(
            r.bell() <= DEPART_BELL,
            "the Depart bell {DEPART_BELL} passed"
        );
        r.now() >= depart_t
    })
    .await;
    r.lock().set_paused(true);
    keeper_down(r);
    let outage_a = json!({"stopped_at": r.now(), "bell": r.bell(),
        "home_resolved_next": r.province_of(hp, hq).map(|v| v.resolved_next)});
    let submits0 = posts(pg, "/gw/f/devnet-play/march/submit");
    let since = r.lock().slot();
    sync_write(
        &sync,
        "go-march-home",
        &json!({"host": host.to_string(), "arrive": ARRIVE_BELL}),
    );
    // the page composes 「村へ戻す」 and presses the card's main button ONCE while its read says NotResident
    let mut pressed = Value::Null;
    run_while(
        r,
        &mut beacon,
        1.0,
        300,
        "the page presses the return march's 出発 while the home read lags",
        |r| {
            let _ = r;
            assert!(
                !sync.join("failed.txt").exists(),
                "the page driver failed: {}",
                std::fs::read_to_string(sync.join("failed.txt")).unwrap_or_default()
            );
            if let Ok(t) = std::fs::read_to_string(sync.join("pressed.json")) {
                pressed = serde_json::from_str(&t).unwrap_or(Value::Null);
            }
            !pressed.is_null()
        },
    )
    .await;
    assert!(
        alive(&mut driver),
        "the driver exited at the press: {pressed:#}"
    );
    assert!(
        pressed["problems"]
            .as_array()
            .is_some_and(|p| p.iter().any(|x| x == "NotResident")),
        "the press happened while the page's read said NotResident: {pressed:#}"
    );
    assert_eq!(
        pressed["armed"], true,
        "the press armed the card's waiting send: {pressed:#}"
    );
    // keeper A stays down another 90 chain seconds: nothing is sent, the card waits by itself
    let hold_until = r.now() + 90;
    run_while(
        r,
        &mut beacon,
        1.0,
        300,
        "keeper A down while the card waits",
        |r| r.now() >= hold_until,
    )
    .await;
    assert_eq!(
        posts(pg, "/gw/f/devnet-play/march/submit"),
        submits0,
        "nothing sent while the home read lags"
    );
    assert!(
        Holding::decode(&r.data(&holding).unwrap()).is_ok_and(|h| h.transit[0].state == 0),
        "no Depart yet"
    );
    let waited = std::fs::read_to_string(sync.join("waiting.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    keeper_up(r, &o, 1).await;
    let restarted_a = json!({"at": r.now(), "bell": r.bell()});
    // the page sends by itself, once, when its read catches up; the wallet signs then
    run_while(
        r,
        &mut beacon,
        1.0,
        480,
        "the page's return march lands by itself after keeper A is back",
        |r| {
            assert!(
                r.bell() <= DEPART_BELL,
                "bell {DEPART_BELL} passed before the page sent its march home"
            );
            Holding::decode(&r.data(&holding).unwrap())
                .is_ok_and(|h| h.transit[0].state == 1 && h.transit[0].host_id == host)
        },
    )
    .await;
    assert!(
        alive(&mut driver),
        "the driver exited before its Depart landed"
    );
    let depart_bell = r.bell();
    let tr = Holding::decode(&r.data(&holding).unwrap()).unwrap().transit[0];
    assert_eq!(
        tr.arrive_bell, ARRIVE_BELL,
        "the page's march home arrives at bell {ARRIVE_BELL}"
    );
    let submits = posts(pg, "/gw/f/devnet-play/march/submit") - submits0;
    assert_eq!(submits, 1, "ONE submit for one press (no spam)");
    // (the reload, as P9: the encrypted book keeps the march)
    run_while(r, &mut beacon, 1.0, 300, "the page reloads", |_| {
        sync.join("reloaded.json").exists()
    })
    .await;
    let reloaded: Value =
        serde_json::from_str(&std::fs::read_to_string(sync.join("reloaded.json")).unwrap())
            .unwrap();
    let kept = |v: &Value| {
        v["entries"].as_array().is_some_and(|e| {
            e.iter().any(|x| {
                x["host"].as_str() == Some(host.to_string().as_str())
                    && x["arriveBell"] == ARRIVE_BELL
                    && x["hasPlain"] == true
            })
        })
    };
    assert!(
        kept(&reloaded["before"]) && kept(&reloaded["after"]),
        "the encrypted book across the reload: {reloaded:#}"
    );
    // 5. OUTAGE B — keeper A stopped across T(21)'s publication; drand-replay comes back WITHOUT T(21).
    let t_pub = genesis_ts + 600 * (ARRIVE_BELL as i64 + 1);
    drive(
        r,
        &mut beacon,
        10.0,
        1500,
        "a minute and a half before T(21)",
        |r| r.now() >= t_pub - 90,
    )
    .await;
    r.lock().set_paused(true);
    let slot_addr = a.arrival_slot(hp, hq, ARRIVE_BELL, joined_nation, 0);
    let anchor = adr(r.ctx().bell_anchor(ARRIVE_BELL, ix::region_of(hp, hq)));
    assert!(r.data(&anchor).is_none() && r.data(&slot_addr).is_none());
    keeper_down(r);
    drand_restart(r, &o, &o.drand_withheld, "without T(21)").await;
    let outage_b = json!({"stopped_at": r.now(), "bell": r.bell(), "t_pub": t_pub});
    // the page's first self-reveal (T(21) + 5 s + its 0–20 s delay) finds no keeper: KeeperUnavailable
    run_while(
        r,
        &mut beacon,
        1.0,
        400,
        "the page's self-reveal is refused while keeper A is down",
        |_| {
            self_attempts(&sync, host, ARRIVE_BELL)
                .iter()
                .any(|(_, x)| x == "KeeperUnavailable")
        },
    )
    .await;
    let first = self_attempts(&sync, host, ARRIVE_BELL);
    // keeper A back (it cannot hold T(21) yet: no anchor, no opening of its own); the page asks again 60 s later
    keeper_up(r, &o, 2).await;
    run_while(
        r,
        &mut beacon,
        1.0,
        400,
        "the page's self-reveal is accepted by keeper A",
        |_| {
            self_attempts(&sync, host, ARRIVE_BELL)
                .iter()
                .any(|(_, x)| x == "accepted")
        },
    )
    .await;
    let accepted = self_attempts(&sync, host, ARRIVE_BELL);
    let accepted_at = r.now();
    assert!(
        r.data(&slot_addr).is_none(),
        "no Reveal before the material was accepted"
    );
    assert!(
        r.data(&anchor).is_none(),
        "no anchor while T(21) is withheld"
    );
    let tracks = std::fs::read_to_string(pg.out.join("reveal-responses.log")).unwrap_or_default();
    let track_id = tracks
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|v| v["body"]["track"].as_str().map(str::to_string));
    // T(21) is served again: keeper A anchors the bell on the real round and the Reveal lands inside the window
    drand_restart(r, &o, &o.drand_full, "with T(21) again").await;
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "keeper A anchors bell 21 from the real round",
        |r| r.data(&anchor).is_some(),
    )
    .await;
    let ad = r.data(&anchor).unwrap();
    let anchor_round = u64::from_le_bytes(ad[BA::ROUND..BA::ROUND + 8].try_into().unwrap());
    let a_ts = le_i64(&ad, BA::A);
    assert_eq!(
        anchor_round, ARRIVE_ROUND,
        "the arrival bell is anchored on the real round"
    );
    let close = {
        let (_, sched, _, _) = r.clock();
        permutation_rules::frontier::beacon::reveal_close(
            a_ts,
            permutation_rules::frontier::beacon::window(&sched, ARRIVE_BELL),
        )
    };
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "the march home is revealed (its ArrivalSlot)",
        |r| r.data(&slot_addr).is_some(),
    )
    .await;
    let revealed_at = r.now();
    assert!(
        revealed_at < close,
        "the Reveal landed inside the window ({revealed_at} < {close})"
    );
    let track = track_id
        .as_ref()
        .and_then(|id| keeper_get(api, &token, &format!("/v1/track/{id}")));
    // 6. The arrival bell resolved; SettleTransit settles the march at home over keeper A's REAL anchor.
    drive(
        r,
        &mut beacon,
        6.0,
        900,
        "keeper A resolves the home province past the arrival bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| v.resolved_next > ARRIVE_BELL)
        },
    )
    .await;
    drive(
        r,
        &mut beacon,
        6.0,
        900,
        "keeper A settles the march home (SettleTransit)",
        |r| Holding::decode(&r.data(&holding).unwrap()).is_ok_and(|h| h.transit[0].state == 0),
    )
    .await;
    r.lock().set_paused(true);
    let at_home = r
        .province_of(hp, hq)
        .and_then(|v| v.entries.into_iter().find(|e| e.id == host));
    assert!(
        at_home.as_ref().is_some_and(|e| e.tile == village),
        "the host stands on its village's tile {village} after the settle: {at_home:?}"
    );
    let rows = r.feed_rows(
        since,
        &[
            T::DEPART,
            T::SETTLE_DEPARTURE,
            T::POST_ANCHOR,
            T::POST_ANCHOR_MULTI,
            T::REVEAL,
            T::GATHER_CLASH,
            T::RESOLVE_FROM_INPUTS,
            T::SKIP_QUIET,
            T::SETTLE_TRANSIT,
            T::CLOSE_ARRIVAL_SLOT,
            T::FOLD_OCCUPANCY,
        ],
        "keeper A / the page",
    );
    let landed = |tag: u8| {
        rows.iter()
            .filter(|x| x["tag"] == format!("0x{tag:02X}") && x["ok"] == true)
            .count()
    };
    for (tag, name) in [
        (T::DEPART, "Depart"),
        (T::SETTLE_DEPARTURE, "SettleDeparture"),
        (T::REVEAL, "Reveal"),
        (T::RESOLVE_FROM_INPUTS, "ResolveFromInputs"),
        (T::SETTLE_TRANSIT, "SettleTransit"),
    ] {
        assert!(landed(tag) > 0, "no {name} landed: {rows:#?}");
    }
    assert_eq!(landed(T::DEPART), 1, "one Depart");
    let play_status = keeper_get(api, &token, "/v1/status")
        .map(|s| s["play"].clone())
        .unwrap_or(Value::Null);
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    sync_write(&sync, "go-final", &json!({"bell": r.bell()}));
    let t0 = Instant::now();
    let done = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("done.json")) {
            break serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        assert!(
            alive(&mut driver),
            "the driver exited before its last stills"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the page did not finish"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    drop(driver);
    let page_txs: Vec<Value> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            (t.message.account_keys.first() == Some(&w)).then(|| {
                json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "signatures": t.signatures.len(),
                       "tag": t.message.instructions.last().and_then(|i| i.data.first().copied()).map(|x| format!("0x{x:02X}")),
                       "compute_units": l.units, "fee": l.fee,
                       "lamports_from_wallet": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
            })
        })
        .collect();
    assert!(
        page_txs.iter().all(|x| x["signatures"] == 1),
        "{page_txs:#?}"
    );
    let verifier = r.judge_season("p10");
    assert_eq!(
        verifier["fails"], 0,
        "the verifier FAILs the season: {verifier:#}"
    );
    json!({"verifier_season": verifier,
        "p10_page_home": "the web page's RETURN march (a Depart to its own village's tile) on the devnet .so, through two keeper A outages: the card waits (one press, one send) while the home read lags; the self-reveal backup is refused while keeper A is down, asked again and accepted; keeper A anchors bell 21 on the real round, the Reveal lands in the window, SettleTransit settles the march at home",
        "participant": {"wallet": w.to_string(), "nation": joined_nation},
        "village": {"p": hp, "q": hq, "site": site, "tile": village, "ticket_bell": ticket_bell, "final_ts": final_ts},
        "return_march": {"muster_tile": start, "dirs_hint": dirs, "muster_bell": muster_bell, "depart_bell": depart_bell, "arrive_bell": ARRIVE_BELL, "submits": submits},
        "outage_a": {"stopped": outage_a, "pressed": pressed, "waiting": waited, "restarted": restarted_a},
        "outage_b": {"stopped": outage_b, "attempts_while_down": first, "attempts_after": accepted, "accepted_at": accepted_at,
                     "track_id": track_id, "track": track, "anchor_round": anchor_round, "anchor_a": a_ts, "close": close, "revealed_at": revealed_at},
        "settled": {"entry": format!("{at_home:?}")}, "keeper_play_status": play_status, "txs": rows,
        "reloaded": reloaded, "page_transactions": page_txs, "driver": done, "declared_patches": r.patches,
        "plan_hint": war_plan, "setup": extra})
}
