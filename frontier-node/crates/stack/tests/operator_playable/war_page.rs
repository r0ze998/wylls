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
    )
    .await;
    assert!(alive(&mut driver), "the driver exited during the war");
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
        "page_transactions": page_txs, "driver": done, "declared_patches": r.patches, "plan_hint": war_plan, "setup": extra})
}
