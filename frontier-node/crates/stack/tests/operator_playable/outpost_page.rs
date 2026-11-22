//! PPOST (devnet-page-outpost): the WEB PAGE founds its SECOND village (FileOutpost) on the devnet wide season, on the
//! exact devnet `.so`, offline — wallet-signed, wallet-paid, through the gateway's devnet play routes; keeper A settles.
//!
//! P4's rim world (the operator's real setup, keeper A with `beacon`, `rings`, `fold`, `tickets` and `rim_per_wedge` 6,
//! the herald in its devnet mode serving the page, the gateway with `--devnet-play`), and:
//!
//! 1. REAL, the page (page_outpost_driver.mjs, its connected TEST wallet): Join and the rim FileTicket; **declared**
//!    anchor + seed of the ticket bell (as P4/P7); REAL keeper A `tickets` role: SettleTicket → the page's first village
//!    on the rim.
//! 2. The page's 2つめ・3つめの村 card: 「近くの州を調べる」 lists the provinces within `outpost_range` past the
//!    heartland, and says of each absent one 「この州はまだ開かれていません」 (the herald has no Province there).
//! 3. **Declared**: RingSeed(r) seeded for the rings of those provinces (a copy of the rim's; on devnet the rings duty
//!    seeds every ring on its way out); REAL OpenProvince for each absent neighbour, sent by a TEST payer as any
//!    permissionless payer would (on devnet keeper A's `provinces_reach` duty does it, #138 — not on main when this ran).
//! 4. REAL, the page: Harvest at every bell (the clock moves 4 h at a time) until the first home is final and its
//!    stores cover the settler cost; the card offers 「ここに村を出す」 on an opened neighbour (a free site as the fog
//!    lets the viewer see it); the FIRST press shows the preview (the rent deposit + the fee, in SOL, and the settler
//!    cost); the SECOND press signs and sends ONE FileOutpost (0xA3) through `/gw/f/devnet-play/act/submit`.
//! 5. **Declared** anchor + seed of the outpost's ticket bell; REAL keeper A `tickets` role: SettleTicket → the page's
//!    SECOND village (order 2). The page shows it on the card (read back from the herald).
//!
//! The wallet's lamports for the FileOutpost must be exactly the preview's total.

use super::*;

/// The page driver of this run.
pub const DRIVER: &str =
    "frontier-node/crates/stack/tests/operator_playable/page_outpost_driver.mjs";
const FILE_OUTPOST_TAG: u8 = 0xA3;

fn ring_of(p: i32, q: i32) -> u32 {
    ProvinceCoord::new(p, q).ring()
}

pub(super) async fn flow(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    nation: u8,
    extra: Value,
) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let regions = sd[S::REGIONS];
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
            .expect("node (the page driver)"),
    );
    let citizen = a.citizen(&w);
    let alive = |d: &mut KillChild| d.0.try_wait().ok().flatten().is_none();
    let failed_note = |sync: &std::path::Path| {
        std::fs::read_to_string(sync.join("failed.txt")).unwrap_or_default()
    };

    // 1. The page Joins and places its first village: on a wide season its planner files a rim ticket (declared
    //    anchor + seed; keeper A settles it), but a page that read the world before P4's declared growth reached the
    //    herald offers a heartland home instead (PlaceHome, final at once; P7's driver has the same race). Either is a
    //    first home a FileOutpost can anchor on.
    // (verify-pr141: the herald's `/h/me` lists each Holding as `{address, slot, seq, head, bytes_b64}` — views.rs
    //  `acct` — not as `{p, q, site, order}`: the place and order are read from the chain's bytes at that address)
    let herald_home = |r: &Run<'_>| -> Option<(i32, i32, u8, Address)> {
        let me = super::super::http_get(pg.herald, &format!("/h/me/{w}"))?;
        me["holdings"].as_array()?.iter().find_map(|h| {
            let at: Address = h["address"].as_str()?.parse().ok()?;
            let d = r.data(&at)?;
            (d.len() > H::OWNER_CITIZEN + 32
                && d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] == citizen.to_bytes()
                && d[H::ORDER] == 1)
                .then(|| {
                    (
                        i16::from_le_bytes([d[H::P], d[H::P + 1]]) as i32,
                        i16::from_le_bytes([d[H::Q], d[H::Q + 1]]) as i32,
                        d[H::SITE],
                        at,
                    )
                })
        })
    };
    let t0 = Instant::now();
    let mut ticket_bell = None;
    let first = loop {
        if let Some(cd) = r.data(&citizen) {
            let tb = le_u32(&cd, C::TICKET_BELL);
            if tb != C::NO_TICKET {
                ticket_bell = Some(tb);
                break None;
            }
        }
        if let Some(h) = herald_home(r) {
            break Some(h);
        }
        assert!(
            alive(&mut driver),
            "the driver exited before the first village: {}",
            failed_note(&sync)
        );
        assert!(
            t0.elapsed() < Duration::from_secs(420),
            "the page placed no first village"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
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
    let (rp, rq, rsite, holding) = match first {
        Some(h) => h,
        None => {
            let tb = ticket_bell.unwrap();
            r.advance_exact(genesis_ts + 600 * (tb as i64 + 1) + 200);
            for region in 0..regions {
                r.stage_seed(tb, region, [0x5A; 32]);
            }
            r.run_until(
                2.0,
                240,
                "keeper A's tickets role settles the page's rim ticket",
                |r| find_home(r).is_some(),
            )
            .await;
            find_home(r).unwrap()
        }
    };
    let home = ProvinceCoord::new(rp, rq);
    let hd = r.data(&holding).unwrap();
    assert_eq!(hd[H::ORDER], 1);
    let final_ts = le_i64(&hd, H::FINAL_TS);
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }

    // 2. The absent neighbours the page must call "not opened yet" (distance 1; else 2), past the heartland, legacy.
    let mut targets: Vec<ProvinceCoord> = vec![];
    for reach in 1..=2i32 {
        for dp in -reach..=reach {
            for dq in (-reach).max(-dp - reach)..=reach.min(-dp + reach) {
                let c = ProvinceCoord::new(rp + dp, rq + dq);
                if home.distance(c) as i32 == reach
                    && c.ring() > u32::from(cq.heartland_max_ring)
                    && c.ring() < u32::from(R_MAX_HARD)
                    && r.lock().account(&a.province(c.p, c.q)).is_none()
                {
                    targets.push(c);
                }
            }
        }
        if !targets.is_empty() {
            break;
        }
    }
    assert!(
        !targets.is_empty(),
        "an absent province next to the rim village"
    );
    let tlist: Vec<String> = targets.iter().map(|c| format!("{} {}", c.p, c.q)).collect();
    std::fs::write(sync.join("go-scan"), tlist.join("\n") + "\n").unwrap();
    let t0 = Instant::now();
    let scan1: Value = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("scan1.json")) {
            break serde_json::from_str(&t).unwrap();
        }
        assert!(
            alive(&mut driver),
            "the driver exited before its first scan: {}",
            failed_note(&sync)
        );
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the page did not scan the nearby provinces"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    for c in &targets {
        let row = scan1["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["p"] == c.p && x["q"] == c.q);
        if let Some(row) = row {
            assert_eq!(
                row["state"], "unopened",
                "the page says ({}, {}) is not opened yet: {scan1:#}",
                c.p, c.q
            );
        }
    }
    assert!(
        scan1["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["state"] == "unopened"),
        "{scan1:#}"
    );

    // 3. Declared: the rings of the targets seeded; REAL OpenProvince for each target (a TEST payer).
    r.lock().set_paused(true);
    let rs128 = r
        .lock()
        .account(&adr(ctx.ring_seed(R_MAX_HARD)))
        .expect("RingSeed(128), declared by P4");
    let mut rings: Vec<u16> = targets.iter().map(|c| c.ring() as u16).collect();
    rings.sort();
    rings.dedup();
    for d in &rings {
        let k = adr(ctx.ring_seed(*d));
        if r.lock()
            .account(&k)
            .is_some_and(|x| x.data[RS::STATUS] == RS::STATUS_SEEDED)
        {
            continue;
        }
        let mut rs = rs128.clone();
        rs.data[RS::D..RS::D + 2].copy_from_slice(&d.to_le_bytes());
        r.patch(
            k,
            rs,
            &format!(
                "RingSeed({d}) seeded (a copy of the rim's; on devnet the rings duty seeds it)"
            ),
        );
    }
    let opener = Keypair::new(); // TEST key: the permissionless payer of OpenProvince
    r.lock().airdrop(&opener.pubkey(), 2 * SOL).unwrap();
    let mut opens = vec![];
    for c in &targets {
        opens.push(r.send(
            &format!("OpenProvince({}, {}) ring {}", c.p, c.q, c.ring()),
            &[fclient::ix::open_province(
                &a,
                opener.pubkey(),
                c.p as i16,
                c.q as i16,
            )],
            &[&opener],
            "test payer (as keeper A's provinces_reach would)",
        ));
    }
    std::fs::write(sync.join("go-outpost"), "go\n").unwrap();

    // 4. The clock moves 4 h at a time; the page harvests after each, and files the outpost once its card is ready.
    let mut t = final_ts.max(r.now()) + 600;
    let mut steps = vec![];
    let mut filed = None;
    for _ in 0..18 {
        r.advance_exact(t);
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        let t1 = Instant::now();
        let mut harvested = false;
        while t1.elapsed() < Duration::from_secs(180) {
            assert!(
                alive(&mut driver),
                "the driver exited while harvesting: {}",
                failed_note(&sync)
            );
            if let Some(cd) = r.data(&citizen) {
                let tb = le_u32(&cd, C::TICKET_BELL);
                if tb != C::NO_TICKET {
                    filed = Some(tb);
                    break;
                }
            }
            if !harvested
                && r.data(&holding)
                    .is_some_and(|d| le_i64(&d, H::LAST_OWNER_ACTION) >= t)
            {
                harvested = true;
                // (the page re-reads its card and may press preview, then send: give it the time)
                let t2 = Instant::now();
                while t2.elapsed() < Duration::from_secs(45) {
                    if r.data(&citizen)
                        .is_some_and(|cd| le_u32(&cd, C::TICKET_BELL) != C::NO_TICKET)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                if let Some(tb) = r
                    .data(&citizen)
                    .map(|cd| le_u32(&cd, C::TICKET_BELL))
                    .filter(|tb| *tb != C::NO_TICKET)
                {
                    filed = Some(tb);
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let hd = r.data(&holding).unwrap();
        steps.push(json!({"clock": t, "harvested_by_page": harvested, "state": hd[H::STATE], "tier": hd[H::TIER]}));
        if filed.is_some() {
            break;
        }
        t += 4 * 3_600;
    }
    let outpost_bell = filed.unwrap_or_else(|| {
        panic!(
            "the page did not file the outpost: {steps:#?}\n{}",
            failed_note(&sync)
        )
    });
    let cd = r.data(&citizen).unwrap();
    let ts = C::TICKET_SITES;
    let (op, oq, os) = (
        i16::from_le_bytes([cd[ts], cd[ts + 1]]) as i32,
        i16::from_le_bytes([cd[ts + 2], cd[ts + 3]]) as i32,
        cd[ts + 4],
    );
    let oc = ProvinceCoord::new(op, oq);
    assert!(
        oc.ring() > u32::from(cq.heartland_max_ring)
            && home.distance(oc) <= u32::from(cq.outpost_range)
    );

    // 5. Declared anchor + seed of the outpost's bell; keeper A settles: the page's second village.
    r.advance_exact(genesis_ts + 600 * (outpost_bell as i64 + 1) + 200);
    for region in 0..regions {
        r.stage_seed(outpost_bell, region, [0x6B; 32]);
    }
    let since = r.lock().slot();
    let outpost = a.holding(op, oq, os);
    r.run_until(
        2.0,
        240,
        "keeper A's tickets role settles the page's outpost",
        |r| {
            r.lock()
                .account(&outpost)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    let settle = r.feed_rows(
        since,
        &[fclient::abi::tag::SETTLE_TICKET],
        "keeper A (tickets role)",
    );
    let od = r.data(&outpost).unwrap();
    assert_eq!(od[H::ORDER], 2, "the second village");
    assert_eq!(
        adr(od[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32]
            .try_into()
            .unwrap()),
        citizen
    );
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    std::fs::write(sync.join("go-final"), format!("{op} {oq} {os}\n")).unwrap();
    let t0 = Instant::now();
    let mut use_from = None;
    let done = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("done.json")) {
            break serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        // (verify-pr141: the new village is used — the clock moves 5 h so its stores fill, then the page harvests it
        //  and presses 「建てる」 and 「訓練する」 on its screen)
        if use_from.is_none() && sync.join("want-use").exists() {
            use_from = Some(r.lock().slot());
            let t = r.now() + 5 * 3_600;
            r.advance_exact(t);
            {
                let mut c = r.lock();
                c.set_scale(1.0);
                c.set_paused(false);
            }
            std::fs::write(sync.join("go-use"), "go\n").unwrap();
        }
        assert!(
            alive(&mut driver),
            "the driver exited before it saw the second village: {}",
            failed_note(&sync)
        );
        assert!(
            t0.elapsed() < Duration::from_secs(600),
            "the page did not show (and use) the second village"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert_eq!(done["outpostVillageShown"], true, "{done}");
    // (the driver writes filed.json after its send's notice: read once the driver is done)
    let filed_info: Value = std::fs::read_to_string(sync.join("filed.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    drop(driver);

    // Every page transaction: the wallet the only signer and the fee payer; the FileOutpost's cost = the preview's.
    let page_txs: Vec<Value> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            (t.message.account_keys.first() == Some(&w)).then(|| {
                let tag = t.message.instructions.iter().find(|i| t.message.account_keys.get(i.program_id_index as usize) == Some(&r.c.program)).and_then(|i| i.data.first().copied());
                json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "signatures": t.signatures.len(), "tag": tag,
                       "compute_units": l.units, "fee": l.fee,
                       "lamports_from_wallet": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
            })
        })
        .collect();
    assert!(
        page_txs.iter().all(|x| x["signatures"] == 1),
        "{page_txs:#?}"
    );
    let fo: Vec<&Value> = page_txs
        .iter()
        .filter(|x| x["tag"] == FILE_OUTPOST_TAG && x["ok"] == true)
        .collect();
    assert_eq!(fo.len(), 1, "one FileOutpost landed: {page_txs:#?}");
    let paid = fo[0]["lamports_from_wallet"].as_u64().unwrap();
    let rent = r.lock().svm.minimum_balance_for_rent_exemption(H::SIZE);
    assert_eq!(
        paid,
        rent + 5_000,
        "the wallet paid one Holding rent (escrow) + the fee"
    );
    // rent-live-rest: the village ticket's escrow preview (the details row, at the cluster's rent the page read from
    // its gateway route) is exactly what the rim FileTicket moved from the wallet besides its fee — at this chain's
    // rate (5,080 or 6,960, OPERATOR_LAMPORTS_PER_BYTE).
    let escrow_preview: Value = std::fs::read_to_string(sync.join("escrow-preview.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let chain_rate = r.lock().svm.minimum_balance_for_rent_exemption(0) / 128;
    assert_eq!(
        escrow_preview["source"], "cluster",
        "the page read the cluster's rent: {escrow_preview}"
    );
    assert_eq!(
        escrow_preview["perByte"]
            .as_str()
            .and_then(|x| x.parse::<u64>().ok()),
        Some(chain_rate),
        "the page's rate is the chain's: {escrow_preview}"
    );
    assert_eq!(
        escrow_preview["shownLamports"], escrow_preview["computed"],
        "{escrow_preview}"
    );
    let shown_escrow = escrow_preview["shownLamports"]
        .as_str()
        .and_then(|x| x.parse::<u64>().ok())
        .expect("the details show the escrow");
    assert_eq!(
        shown_escrow, rent,
        "before Join: one Holding rent at the chain's rate"
    );
    // (the first village: the rim FileTicket moves the escrow into the Citizen; the heartland fallback PlaceHome pays
    //  the same one Holding rent for the village it makes — either is the previewed figure plus the fee)
    let first_tx = page_txs.iter().find(|x| {
        (x["tag"] == fclient::abi::tag::FILE_TICKET || x["tag"] == fclient::abi::tag::PLACE_HOME)
            && x["ok"] == true
    });
    let ticket_check = {
        let t = first_tx.expect("the page's first-village command landed");
        let from_wallet = t["lamports_from_wallet"].as_u64().unwrap();
        let fee = t["fee"].as_u64().unwrap();
        assert_eq!(
            from_wallet,
            shown_escrow + fee,
            "the first village moved exactly the previewed Holding rent (+ its fee): {t}"
        );
        json!({"command": if t["tag"] == fclient::abi::tag::FILE_TICKET { "FileTicket" } else { "PlaceHome" },
               "lamports_from_wallet": from_wallet, "fee": fee, "rent_debited": from_wallet - fee,
               "rent_previewed": shown_escrow, "equal": true})
    };
    if let Some(total) = filed_info["preview"]["totalLamports"].as_str() {
        assert_eq!(
            total.parse::<u64>().unwrap(),
            paid,
            "the preview named exactly what the wallet paid"
        );
    } else {
        panic!("the driver recorded no preview: {filed_info}");
    }
    // (verify-pr141) The second village is usable: the page's Build and Train after the settle name it, and land.
    let used: Vec<Value> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter(|l| l.slot >= use_from.unwrap_or(u64::MAX))
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            if t.message.account_keys.first() != Some(&w) || !t.message.account_keys.contains(&outpost) {
                return None;
            }
            let tag = t.message.instructions.iter().find(|i| t.message.account_keys.get(i.program_id_index as usize) == Some(&r.c.program)).and_then(|i| i.data.first().copied())?;
            Some(json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "tag": tag, "compute_units": l.units}))
        })
        .collect();
    for (tag, what) in [
        (fclient::abi::tag::BUILD, "Build"),
        (fclient::abi::tag::TRAIN, "Train"),
    ] {
        assert!(
            used.iter().any(|x| x["tag"] == tag && x["ok"] == true),
            "the page's {what} in the second village landed: {used:#?}\n{:#}",
            done["use"]
        );
    }
    let keeper_alive = r.c.keeper.try_wait().ok().flatten().is_none();
    assert!(keeper_alive, "keeper A exited");
    json!({
        "ppost_page": "the web page founds its second village: Join, rim FileTicket, Harvest, FileOutpost (2-press preview) — wallet-signed, wallet-paid, via the gateway's devnet play routes; keeper A settles",
        "participant": {"wallet": w.to_string(), "nation_hint": nation},
        "first_village": {"p": rp, "q": rq, "site": rsite, "ring": home.ring(), "by": if ticket_bell.is_some() { "rim FileTicket, keeper A settled" } else { "PlaceHome (heartland)" }, "ticket_bell": ticket_bell, "final_ts": final_ts},
        "absent_neighbours": targets.iter().map(|c| json!({"p": c.p, "q": c.q, "ring": ring_of(c.p, c.q)})).collect::<Vec<_>>(),
        "page_scan_before_open": scan1, "open_province_by_test_payer": opens, "harvest_steps": steps,
        "outpost": {"p": op, "q": oq, "site": os, "ring": oc.ring(), "distance": home.distance(oc), "ticket_bell": outpost_bell,
                    "in_a_province_opened_here": targets.contains(&oc), "wallet_lamports": paid, "holding_rent": rent},
        "page_filed": filed_info, "second_village_used": used, "keeper_settle_ticket": settle,
        "rent": {"chain_lamports_per_byte": chain_rate, "escrow_preview": escrow_preview, "file_ticket": ticket_check,
                 "outpost_preview_total": filed_info["preview"]["totalLamports"], "outpost_paid": paid},
        "page_transactions": page_txs, "driver": done, "declared_patches": r.patches, "setup": extra,
    })
}
