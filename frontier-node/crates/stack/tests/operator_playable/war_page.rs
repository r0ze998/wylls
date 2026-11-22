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
                "--scenario",
                if pg.capture { "capture" } else { "keep" },
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
        signed: Default::default(),
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
        if pg.capture {
            super::Hold {
                after_bells: super::env_or("OPERATOR_PCAP_AFTER_BELLS", PCAP_AFTER_BELLS),
                scale: super::env_or("OPERATOR_PCAP_HOLD_SCALE", PCAP_HOLD_SCALE),
            }
        } else {
            super::Hold {
                after_bells: AFTER_BELLS,
                scale: 40.0,
            }
        },
    )
    .await;
    assert!(alive(&mut driver), "the driver exited during the war");
    // PCAP (devnet-72bell-pair): the capture on chain, in the herald, and on the page.
    let capture = if pg.capture {
        Some(
            capture_seen(
                r,
                pg,
                &mut driver,
                &mut beacon,
                &sync,
                (tp, tq),
                joined_nation,
                &war,
            )
            .await,
        )
    } else {
        None
    };
    // (PFOG: the last look, then the owner's fog rules over every snapshot)
    let fog = match observers.take() {
        Some(o) => {
            let v = super::fog::finish(r, o, &mut beacon, &pg.out).await;
            assert!(
                v["failures"].as_array().is_some_and(|f| f.is_empty()),
                "the fog of war on the devnet page: {:#}",
                json!({"failures": v["failures"], "checks": v["checks"], "plan": v["plan"], "table": v["table"]})
            );
            Some(
                json!({"checks": v["checks"], "failures": v["failures"], "plan": v["plan"], "table": v["table"]}),
            )
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
        "page_transactions": page_txs, "driver": done, "declared_patches": r.patches, "plan_hint": war_plan, "setup": extra, "fog": fog,
        "capture": capture})
}

/// PCAP (devnet-72bell-pair): after [`keeper_war`] — the keep taken on chain (72 held bells), the herald's keep
/// history (`/h/keep/{P},{Q}.json`: holder, capture record) and day file (`/h/conquest/{day}.json`: `keep_taken`), and
/// the page's own words: the driver opens the guide (「ガイド：州を奪いました」, 「…が州 P,Q を奪いました」) and
/// writes what it read into `<sync>/capture-page.json`.
#[allow(clippy::too_many_arguments)]
async fn capture_seen(
    r: &mut Run<'_>,
    pg: &Page,
    driver: &mut KillChild,
    beacon: &mut Beacon,
    sync: &std::path::Path,
    (tp, tq): (i32, i32),
    nation: u8,
    war: &Value,
) -> Value {
    assert!(
        !war["taken"].is_null(),
        "the keep of ({tp}, {tq}) was not taken within the window: {:#}",
        json!({"keep_final": war["keep_final"], "lag": war["keeper_lag"]["lag_bells"], "hold": war["hold"]})
    );
    let k = r
        .province_of(tp, tq)
        .and_then(|v| v.cq.and_then(|c| c.keep))
        .unwrap();
    assert_eq!(k.holder, nation, "the keep's holder on chain");
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    // the herald: the keep's history and the day's keep_taken event
    let t0 = Instant::now();
    let (keep_json, day_event) = loop {
        let kj = crate::http_get(pg.herald, &format!("/h/keep/{tp},{tq}.json"));
        let held = kj
            .as_ref()
            .is_some_and(|v| v["holder"].as_u64() == Some(nation as u64));
        let day = (k.since_bell / 144) as u64;
        let ev = crate::http_get(pg.herald, &format!("/h/conquest/{day}.json")).and_then(|d| {
            d["events"].as_array().and_then(|e| {
                e.iter()
                    .find(|x| {
                        x.to_string().contains("keep_taken")
                            && x.to_string().contains(&format!("{tp}"))
                    })
                    .cloned()
            })
        });
        if let (true, Some(e)) = (held, ev.as_ref()) {
            break (kj.unwrap(), e.clone());
        }
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the herald never showed the capture of ({tp}, {tq}): keep {kj:?}, day event {ev:?}"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    };
    // the page
    sync_write(
        sync,
        "go-capture",
        &json!({"p": tp, "q": tq, "nation": nation}),
    );
    let t0 = Instant::now();
    let page_said: Value = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("capture-page.json")) {
            break serde_json::from_str(&t).unwrap_or(json!({"raw": t}));
        }
        assert!(
            driver.0.try_wait().ok().flatten().is_none(),
            "the driver exited before it read the capture"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(900),
            "the page never said it took the keep"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    };
    let want = format!("州 {tp},{tq} を奪いました");
    assert!(
        page_said["texts"].as_array().is_some_and(|t| t
            .iter()
            .any(|x| x.as_str().is_some_and(|x| x.contains(&want)))),
        "the page says 「{want}」: {page_said:#}"
    );
    json!({"chain_keep": format!("{k:?}"), "herald_keep": keep_json, "herald_day_event": day_event, "page": page_said})
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
        signed: Default::default(),
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

// ------------------------------------------------------------------ PPAIR (devnet-72bell-pair)

/// The herald's record of province `(p, q)` (`/h/province/{p},{q}/latest`) decoded, or None while it has none.
fn herald_province(port: u16, p: i32, q: i32) -> Option<fclient::decode::Province> {
    use base64::Engine;
    let v = crate::http_get(port, &format!("/h/province/{p},{q}/latest"))?;
    fn b64(v: &Value) -> Option<String> {
        match v {
            Value::Object(m) => m
                .get("bytes_b64")
                .and_then(|x| x.as_str().map(str::to_string))
                .or_else(|| m.values().find_map(b64)),
            Value::Array(a) => a.iter().find_map(b64),
            _ => None,
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64(&v)?)
        .ok()?;
    fclient::decode::Province::decode(&bytes).ok()
}

/// The OUT leg's destination: the nearest passable tile of the neighbour `target` that is not its keep's, reached from
/// the muster tile `start` of `home` over the two provinces' passable tiles, never through the keep's (BFS). →
/// `(tile, dirs)`.
fn out_leg(
    home: (i32, i32),
    hp_mask: u64,
    start: u8,
    target: (i32, i32),
    tp_mask: u64,
    keep_tile: u8,
) -> Option<(u8, Vec<u8>)> {
    use permutation_rules::frontier::geometry::locate;
    use permutation_rules::hex::{Hex, DIRECTIONS};
    use std::collections::{HashMap, VecDeque};
    let ok = |pc: (i32, i32), t: u8| {
        t < 61
            && ((pc == home && hp_mask & (1u64 << t) != 0)
                || (pc == target && t != keep_tile && tp_mask & (1u64 << t) != 0))
    };
    let s = super::hex_of(home.0, home.1, start)?;
    let mut prev: HashMap<(i32, i32), Option<((i32, i32), u8)>> = HashMap::new();
    prev.insert((s.q, s.r), None);
    let mut queue = VecDeque::from([s]);
    while let Some(h) = queue.pop_front() {
        let (pc, t) = locate(h);
        if (pc.p, pc.q) == target && t != keep_tile {
            let mut dirs = vec![];
            let mut cur = (h.q, h.r);
            while let Some(Some((from, d))) = prev.get(&cur) {
                dirs.push(*d);
                cur = *from;
            }
            dirs.reverse();
            return Some((t, dirs));
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

/// PPAIR: an OUT-AND-BACK march pair on the devnet page path. The page (its wallet a Wallet Standard TEST wallet) joins,
/// founds its rim village, harvests and musters 400 (as P9). OUT: a sealed Depart signed by the page's wallet key to the
/// first tile of the neighbouring province on the way to its keep, arriving at [`PAIR_OUT_ARRIVE`] — sealed to the TEST
/// beacon key over a declared TEST-signed anchor (offline there is one real arrival round only, see
/// [`PAIR_OUT_ARRIVE`]); the wallet reveals it (as an owner may); keeper A settles the departure, gathers, resolves and
/// settles the transit: the host stands in the neighbour's province. HOME: the PAGE's own 「村へ戻す」 from there — its
/// card, its time-lock to the REAL T(21), its wallet; keeper A anchors bell 21 from the real round, opens the seal,
/// reveals, resolves and settles it at the village's tile. Both legs settled, the host home, the herald's records of
/// both provinces agree with the chain, the verifier judges the whole season.
pub(super) async fn flow_pair(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    war_plan: Value,
    extra: Value,
) -> Value {
    use fclient::abi::tag as T;
    use std::os::unix::fs::PermissionsExt;
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
                "pair",
            ])
            .stdout(std::fs::File::create(pg.out.join("driver.out.log")).unwrap())
            .stderr(std::fs::File::create(pg.out.join("driver.err.log")).unwrap())
            .spawn()
            .expect("node (the page war driver)"),
    );
    let citizen = a.citizen(&w);
    let alive = |d: &mut KillChild| d.0.try_wait().ok().flatten().is_none();
    let no_fail = |sync: &std::path::Path| {
        assert!(
            !sync.join("failed.txt").exists(),
            "the page driver failed: {}",
            std::fs::read_to_string(sync.join("failed.txt")).unwrap_or_default()
        );
    };
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
        signed: Default::default(),
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
    let ((tp, tq), keep0, start, _) =
        keep_target(r, plan, (hp, hq), joined_nation).unwrap_or_else(|| {
            panic!("no neighbouring province with a route beside the page's village ({hp}, {hq})")
        });
    let (out_tile, out_dirs) = out_leg(
        (hp, hq),
        r.province_of(hp, hq).unwrap().passable_mask,
        start,
        (tp, tq),
        r.province_of(tp, tq).unwrap().passable_mask,
        keep0.tile,
    )
    .unwrap_or_else(|| panic!("no passable tile of ({tp}, {tq}) but its keep's within reach"));
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
    // 3. Declared: the reserve (as P9); keeper A makes the home resident; the page musters onto the route's start.
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
    // the OUT leg's bells: the planned ones, or the first after the muster (the host must be on the map a bell first)
    let out_depart = PAIR_OUT_DEPART.max(muster_bell + 1);
    let out_arrive = out_depart + 2;
    assert!(
        out_arrive + 4 < DEPART_BELL,
        "the page mustered at bell {muster_bell}: no room for the OUT leg before the HOME leg's bell {DEPART_BELL}"
    );
    // 4. OUT: the Depart bell, the home resident; the wallet's sealed Depart (TEST beacon key) to the neighbour.
    let depart_t = genesis_ts + 600 * out_depart as i64 + 30;
    drive(
        r,
        &mut beacon,
        20.0,
        1500,
        "five minutes before the OUT Depart bell",
        |r| r.now() >= depart_t - 330,
    )
    .await;
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "the OUT Depart bell, the home resident",
        |r| {
            assert!(
                r.bell() <= out_depart,
                "the OUT Depart bell {out_depart} passed before the home was resident"
            );
            r.now() >= depart_t
                && r.province_of(hp, hq)
                    .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);
    let test_key = fb::TestKey::new();
    let t_out = {
        let (clock, _, _, g) = r.clock();
        kb::tlock_round(&clock, g, out_arrive)
    };
    let me = ix::Player {
        actor: w,
        payer: w,
        wallet: w,
    };
    let href = ix::HoldingRef {
        p: hp as i16,
        q: hq as i16,
        site,
    };
    let (path_len, path) = permutation_rules::frontier::seal::encode_path(&out_dirs).unwrap();
    let plain =
        permutation_rules::frontier::seal::pack(&permutation_rules::frontier::seal::Plain {
            version: permutation_rules::frontier::seal::PLAIN_VERSION,
            host_id: host,
            arrive_bell: out_arrive,
            dest_p: tp as _,
            dest_q: tq as _,
            dest_tile: out_tile,
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: Default::default(),
        });
    let sealed = fclient::seal::seal(&plain, &test_key.pk96, t_out).unwrap();
    let season = fclient::decode::Season::decode(&r.season()).unwrap();
    let tip = fclient::fees::min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let since = r.lock().slot();
    let out_depart_row = r.send(
        &format!("OUT Depart to ({tp}, {tq}) tile {out_tile}, arrival bell {out_arrive} (sealed to the TEST beacon key)"),
        &[ix2::depart(
            &a,
            &me,
            href,
            (hp as i16, hq as i16),
            &ix::DepartArgs {
                host_id: host,
                commit: sealed.commit,
                seal: sealed.seal,
                arrive_bell: out_arrive,
                tip,
                transit_slot: 0,
            },
        )],
        &[&player],
        "the page's wallet (TEST seal)",
    );
    assert_eq!(
        out_depart_row["ok"], true,
        "the OUT Depart: {out_depart_row:#}"
    );
    let out_region = ix::region_of(tp, tq);
    beacon
        .signed
        .insert((out_arrive, out_region), test_key.sign(t_out));
    // 5. OUT arrival: the declared, TEST-signed anchor (staged by the beacon once the bell ended); the wallet reveals.
    let out_anchor = adr(r.ctx().bell_anchor(out_arrive, out_region));
    drive(
        r,
        &mut beacon,
        10.0,
        1500,
        "the OUT arrival bell ends (its declared TEST-signed anchor)",
        |r| r.data(&out_anchor).is_some(),
    )
    .await;
    r.lock().set_paused(true);
    let tr = Holding::decode(&r.data(&holding).unwrap()).unwrap().transit[0];
    assert_eq!(tr.host_id, host, "the OUT march's transit");
    let path_provinces =
        fclient::play::path_provinces((hp, hq, start), &fclient::seal::unpack(&plain))
            .expect("the OUT path's provinces");
    let reveal_of = |day_writable: bool| {
        ix::reveal(
            &a,
            w,
            &ix::RevealArgs {
                holding: href,
                transit_slot: 0,
                target_i: 0,
                plain,
                salt: sealed.salt,
                ct_hash: sealed.ct_hash,
                beneficiary: w,
                dest: (tp, tq),
                arrive: out_arrive,
                faction: joined_nation,
                day_writable,
                path_provinces: path_provinces.clone(),
            },
        )
    };
    let dw = r.simulate_ok(&[reveal_of(true)], &[&player]).is_ok();
    let out_reveal = r.send(
        &format!("OUT Reveal (the wallet, bell {out_arrive})"),
        &[reveal_of(dw)],
        &[&player],
        "the page's wallet",
    );
    assert_eq!(out_reveal["ok"], true, "the OUT Reveal: {out_reveal:#}");
    // 6. keeper A gathers, resolves and settles the OUT leg: the host stands in the neighbour's province.
    let entry_at = |r: &Run<'_>, p: i32, q: i32| {
        r.province_of(p, q)
            .and_then(|v| v.entries.into_iter().find(|e| e.id == host))
    };
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A settles the OUT leg (SettleTransit): the host stands in the neighbour's province",
        |r| {
            Holding::decode(&r.data(&holding).unwrap()).is_ok_and(|h| h.transit[0].state == 0)
                && entry_at(r, tp, tq).is_some()
        },
    )
    .await;
    r.lock().set_paused(true);
    let out_entry = entry_at(r, tp, tq).unwrap();
    assert_eq!(out_entry.tile, out_tile, "the host on the OUT leg's tile");
    let out_settled_bell = r.bell();
    let out_rows = r.feed_rows(
        since,
        &[
            T::DEPART,
            T::SETTLE_DEPARTURE,
            T::REVEAL,
            T::GATHER_CLASH,
            T::RESOLVE_FROM_INPUTS,
            T::SETTLE_TRANSIT,
        ],
        "OUT leg",
    );
    // the herald sees the host abroad
    let t0 = Instant::now();
    let herald_out = loop {
        let hv = herald_province(r.c.herald, tp, tq);
        if hv
            .as_ref()
            .is_some_and(|v| v.entries.iter().any(|e| e.id == host && e.tile == out_tile))
        {
            break true;
        }
        if t0.elapsed() > Duration::from_secs(180) {
            break false;
        }
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    };
    assert!(
        herald_out,
        "the herald's record of ({tp}, {tq}) shows the host on tile {out_tile}"
    );
    // 7. HOME: the HOME Depart bell with BOTH provinces resident; the page's own 「村へ戻す」 to T(21).
    let depart_t = genesis_ts + 600 * DEPART_BELL as i64 + 30;
    drive(
        r,
        &mut beacon,
        20.0,
        1500,
        "five minutes before the HOME Depart bell",
        |r| r.now() >= depart_t - 330,
    )
    .await;
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "the HOME Depart bell, both provinces resident",
        |r| {
            assert!(
                r.bell() <= DEPART_BELL,
                "the HOME Depart bell {DEPART_BELL} passed before both provinces were resident"
            );
            r.now() >= depart_t
                && [(hp, hq), (tp, tq)].iter().all(|&(p, q)| {
                    r.province_of(p, q)
                        .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
                })
        },
    )
    .await;
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let submits0 = posts(pg, "/gw/f/devnet-play/march/submit");
    let since_home = r.lock().slot();
    sync_write(
        &sync,
        "go-march-home",
        &json!({"host": host.to_string(), "arrive": ARRIVE_BELL}),
    );
    let home_transit = |r: &Run<'_>| {
        Holding::decode(&r.data(&holding).unwrap())
            .ok()
            .and_then(|h| {
                h.transit
                    .iter()
                    .position(|x| x.state == 1 && x.host_id == host)
                    .map(|i| (i, h.transit[i]))
            })
    };
    let mut beat = Instant::now();
    run_while(
        r,
        &mut beacon,
        1.0,
        480,
        "the page's march home lands (its Depart)",
        |r| {
            no_fail(&sync);
            if beat.elapsed() > Duration::from_secs(5) {
                beat = Instant::now();
                assert!(
                    r.bell() <= DEPART_BELL,
                    "bell {DEPART_BELL} passed before the page sent its march home"
                );
            }
            home_transit(r).is_some()
        },
    )
    .await;
    assert!(
        alive(&mut driver),
        "the driver exited before its Depart landed"
    );
    let home_depart_bell = r.bell();
    let (home_slot, tr) = home_transit(r).unwrap();
    assert_eq!(
        tr.arrive_bell, ARRIVE_BELL,
        "the page's march home arrives at bell {ARRIVE_BELL}"
    );
    let pressed = std::fs::read_to_string(sync.join("pressed.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or(Value::Null);
    let submits = posts(pg, "/gw/f/devnet-play/march/submit") - submits0;
    assert_eq!(submits, 1, "ONE submit for the page's one press");
    // (the reload, as P9: the encrypted book keeps the march)
    run_while(r, &mut beacon, 1.0, 300, "the page reloads", |_| {
        sync.join("reloaded.json").exists()
    })
    .await;
    let reloaded: Value =
        serde_json::from_str(&std::fs::read_to_string(sync.join("reloaded.json")).unwrap())
            .unwrap();
    // 8. keeper A anchors bell 21 from the REAL round, opens the seal, reveals, resolves, settles at the village tile.
    let home_region = ix::region_of(hp, hq);
    let anchor = adr(r.ctx().bell_anchor(ARRIVE_BELL, home_region));
    drive(
        r,
        &mut beacon,
        10.0,
        1500,
        "keeper A anchors bell 21 from the real round T(21)",
        |r| r.data(&anchor).is_some(),
    )
    .await;
    let ad = r.data(&anchor).unwrap();
    let anchor_round = u64::from_le_bytes(ad[BA::ROUND..BA::ROUND + 8].try_into().unwrap());
    assert_eq!(
        anchor_round, ARRIVE_ROUND,
        "bell 21 is anchored on the real round"
    );
    let slot_addr = a.arrival_slot(hp, hq, ARRIVE_BELL, joined_nation, 0);
    drive(
        r,
        &mut beacon,
        4.0,
        900,
        "the march home is revealed (its ArrivalSlot)",
        |r| r.data(&slot_addr).is_some(),
    )
    .await;
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A settles the march home (SettleTransit): the host on its village's tile",
        |r| {
            home_transit(r).is_none()
                && Holding::decode(&r.data(&holding).unwrap())
                    .is_ok_and(|h| h.transit.iter().all(|x| x.host_id != host || x.state == 0))
                && entry_at(r, hp, hq).is_some()
        },
    )
    .await;
    r.lock().set_paused(true);
    let home_entry = entry_at(r, hp, hq).unwrap();
    assert_eq!(
        home_entry.tile, village,
        "the host is home, on its village's tile {village}"
    );
    assert!(
        entry_at(r, tp, tq).is_none(),
        "the host left the neighbour's province"
    );
    let home_settled_bell = r.bell();
    let home_rows = r.feed_rows(
        since_home,
        &[
            T::DEPART,
            T::SETTLE_DEPARTURE,
            T::POST_ANCHOR,
            T::POST_ANCHOR_MULTI,
            T::REVEAL,
            T::GATHER_CLASH,
            T::RESOLVE_FROM_INPUTS,
            T::SETTLE_TRANSIT,
        ],
        "HOME leg",
    );
    let landed = |rows: &[Value], tag: u8| {
        rows.iter()
            .filter(|x| x["tag"] == format!("0x{tag:02X}") && x["ok"] == true)
            .count()
    };
    for (rows, leg) in [(&out_rows, "OUT"), (&home_rows, "HOME")] {
        for (tag, name) in [
            (T::DEPART, "Depart"),
            (T::SETTLE_DEPARTURE, "SettleDeparture"),
            (T::REVEAL, "Reveal"),
            (T::RESOLVE_FROM_INPUTS, "ResolveFromInputs"),
            (T::SETTLE_TRANSIT, "SettleTransit"),
        ] {
            assert!(
                landed(rows, tag) > 0,
                "{leg} leg: no {name} landed: {rows:#?}"
            );
        }
        assert_eq!(landed(rows, T::DEPART), 1, "{leg} leg: one Depart");
    }
    // 9. The herald agrees with the chain: the host home in its province's record, gone from the neighbour's.
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let t0 = Instant::now();
    let herald_home = loop {
        let home_v = herald_province(r.c.herald, hp, hq);
        let out_v = herald_province(r.c.herald, tp, tq);
        let ok = home_v
            .as_ref()
            .is_some_and(|v| v.entries.iter().any(|e| e.id == host && e.tile == village))
            && out_v
                .as_ref()
                .is_some_and(|v| v.entries.iter().all(|e| e.id != host));
        if ok {
            break json!({"home": format!("{:?}", home_v.unwrap().entries.iter().find(|e| e.id == host)), "seconds": t0.elapsed().as_secs_f64()});
        }
        assert!(
            t0.elapsed() < Duration::from_secs(240),
            "the herald's records of ({hp}, {hq}) / ({tp}, {tq}) never showed the host home"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    };
    let play_status = keeper_get(api, &token, "/v1/status")
        .map(|s| s["play"].clone())
        .unwrap_or(Value::Null);
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
    let verifier = r.judge_season("ppair");
    assert_eq!(
        verifier["fails"], 0,
        "the verifier FAILs the season: {verifier:#}"
    );
    json!({"verifier_season": verifier,
        "ppair": "an out-and-back march pair on the devnet .so: OUT (the page's wallet, sealed to the TEST beacon key over a declared TEST-signed anchor: no second real round offline) to the neighbour's province; HOME (the page's own card, time-lock to the REAL T(21)); keeper A settles both; the host home; the herald agrees",
        "participant": {"wallet": w.to_string(), "nation": joined_nation},
        "village": {"p": hp, "q": hq, "site": site, "tile": village, "ticket_bell": ticket_bell, "final_ts": final_ts},
        "out": {"to": [tp, tq], "tile": out_tile, "dirs": out_dirs, "start_tile": start, "muster_bell": muster_bell, "depart_bell": out_depart, "arrive_bell": out_arrive,
                "t_round": t_out, "depart": out_depart_row, "reveal": out_reveal, "reveal_day_writable": dw, "settled_bell": out_settled_bell, "entry": format!("{out_entry:?}"), "txs": out_rows},
        "home": {"depart_bell": home_depart_bell, "transit_slot": home_slot, "arrive_bell": ARRIVE_BELL, "anchor_round": anchor_round, "submits": submits, "pressed": pressed,
                 "settled_bell": home_settled_bell, "entry": format!("{home_entry:?}"), "txs": home_rows},
        "herald": {"out_seen": herald_out, "home": herald_home},
        "keeper_play_status": play_status, "reloaded": reloaded, "page_transactions": page_txs, "driver": done,
        "declared_patches": r.patches, "plan_hint": war_plan, "setup": extra})
}

/// PKF (devnet-72bell-pair; key-free): PPAIR's OUT leg ends on the neighbour's nearest tile that is not its keep's,
/// its path entering the neighbour only at its last step; a keep tile right at the border is stepped around.
#[test]
fn pkf_out_leg_stops_at_the_neighbours_nearest_tile_not_its_keep() {
    use permutation_rules::frontier::geometry::locate;
    use permutation_rules::hex::{Hex, DIRECTIONS};
    let all = (1u64 << 61) - 1;
    let (home, target) = ((20, -10), (21, -10));
    for keep in [0u8, 7, 30, 60] {
        let (start, _) =
            super::route(home, all, target, all, keep).expect("a route to the keep's tile");
        let (tile, dirs) = out_leg(home, all, start, target, all, keep).expect("an OUT tile");
        assert_ne!(tile, keep, "not the keep's tile");
        assert!(
            !dirs.is_empty() && dirs.len() <= permutation_rules::frontier::travel::MAX_PATH_STEPS
        );
        let mut h = super::hex_of(home.0, home.1, start).unwrap();
        for (i, &d) in dirs.iter().enumerate() {
            let (dq, dr) = DIRECTIONS[d as usize];
            h = Hex::new(h.q + dq, h.r + dr);
            let (pc, t) = locate(h);
            assert_eq!(
                (pc.p, pc.q) == target,
                i + 1 == dirs.len(),
                "keep {keep}: enters at the end"
            );
            if i + 1 == dirs.len() {
                assert_eq!(t, tile);
            }
        }
    }
    // (an impassable neighbour: no OUT tile)
    assert!(out_leg(home, all, 0, target, 1u64 << 5, 5).is_none());
}
