//! P11 (devnet-expedition-keeper; devnet runbook gaps P10 + P13): a RIM → WIDE EXPEDITION on a devnet wide season,
//! offline, on the exact devnet `.so`, driven by keeper A after the player's ExpeditionDepart.
//!
//! After P5's world (the operator's setup; keeper A seeding the season, opening the rim's provinces and, with
//! `wide_rings` 1, the wide ring 129 on a SHIPPED round), with keeper A configured as the devnet profile now says
//! (P8's play roles plus **`expeditions`**):
//!
//! 1. REAL, a test participant: Join and a one-site rim FileTicket beside a ring-129 province keeper A opened; keeper
//!    A's `tickets` role settles it; the clock past `final_ts`; Harvest flips it final.
//! 2. **Declared patch**: 400 Spearmen in the village's reserve (as P6/P8).
//! 3. REAL, keeper A's `skip`: the home resolved so that Muster is resident; REAL, the participant: Muster 400 onto the
//!    home tile its route into ring 129 starts from (the program's own passable masks, `expedition_steps::
//!    derive_route`).
//! 4. REAL, the participant: ONE **ExpeditionDepart** (the 0x4804 wrapper, kind 0; the page's 「境界への道を準備」),
//!    sealed with a real wide time-lock to T([`ARRIVE_BELL`]) under the quicknet key, the canonical message of
//!    `fclient::experimental_expedition_message::prepare_depart` signed by the participant's TEST wallet alone.
//! 5. REAL, keeper A, nothing sent by the test: the origin's departure bell (the play duty's gather and resolve, handed
//!    the bell by the `expeditions` role), **ExpeditionSettleOrigin**, THE anchor of bell 21 from the REAL round
//!    T(21), the **ExpeditionReveal** opened from that public round, the destination's catch-up wide **Resolve**s,
//!    **ExpeditionGather**, the arrival's **Resolve**, **SettleMember**.
//! 6. The host STAYS on ring 129; keeper A's feed guard is still `legacy` (the expedition's records applied, P10) and
//!    it keeps folding and resolving afterwards; the verifier (with the pinned `.so` for VX) judges the WHOLE season.
//!
//! **Declared patches** (logged, and the verifier's `declared` list): P5's, the troops, and THE anchor and SeedCache of
//! every bell no shipped round covers in every region (as P8), except bell 21's anchor (keeper A's real PostAnchor),
//! whose seed is declared over it.
#![allow(clippy::too_many_arguments)]
use super::war::{drive, Beacon, ARRIVE_BELL, ARRIVE_ROUND, TROOPS};
use super::*;
use fclient::decode::{Holding, Province};
use fclient::experimental_expedition_message::{prepare_depart, Target, DEPART_HEAP_FRAME};
use fclient::original_expedition_depart_draft::Draft;
use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
use frontier_abi::world_index::arrival::{
    arrival_slot_address, clash_inputs_address, wide_arrival, WideArrival, WideClashInputsHdr,
};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::march::MarchState;
use frontier_abi::world_index::seal::WidePlain;
use frontier_abi::world_index::{ProvinceKey, TileAddress};
use keeper_core::expedition_steps as steps;

fn program_rows(r: &Run<'_>, since_slot: u64) -> Vec<Value> {
    let program = r.c.program;
    r.lock()
        .feed(0, 1_000_000, Some(&program))
        .into_iter()
        .filter(|l| l.slot > since_slot)
        .map(|l| {
            json!({"slot": l.slot, "tx": super::super::ix_name(&l.wire, &program), "ok": l.err.is_none(),
                   "err": l.err, "compute_units": l.units, "fee": l.fee,
                   "lamports_from_payer": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
        })
        .collect()
}

/// verify-pr121 (`OPERATOR_P11_RESTARTS=1`): kill keeper A and start it again from the same config and journal.
fn restart_keeper(r: &mut Run<'_>, n: &mut u32, why: &str) {
    let Some(restart) = r.c.p11_restarts.as_ref() else {
        return;
    };
    let (bin, config) = (restart.bin.clone(), restart.config.clone());
    {
        let child = &mut *r.c.keeper;
        let _ = child.kill();
        let _ = child.wait();
    }
    *n += 1;
    eprintln!("p11: keeper A restart {n} ({why})");
    *r.c.keeper = std::process::Command::new(&bin)
        .args(["--config", config.to_str().unwrap()])
        .env("FRONTIER_KEEPER_TICK_LOG", "1")
        .stdout(std::fs::File::create(r.c.dir.join(format!("keeper-restart{n}.out.log"))).unwrap())
        .stderr(std::fs::File::create(r.c.dir.join(format!("keeper-restart{n}.log"))).unwrap())
        .spawn()
        .expect("frontier-keeper (restarted)");
}

pub(super) async fn flow(
    r: &mut Run<'_>,
    (hp, hq, site, nation): (i32, i32, u8, u8),
    target: WideCoord,
    extra: Value,
) -> Value {
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let program = r.c.program;
    let genesis_ts = r.clock().3;
    let mut beacon = Beacon {
        regions: (0..r.season()[S::REGIONS]).collect(),
        staged: Default::default(),
        from_bell: 0,
    };
    let war =
        r.c.war
            .as_ref()
            .map(|w| (w.keeper_api, w.token.clone()))
            .expect("keeper A's API");

    // 1. the rim village (P12: founded by the PAGE — its home planner's one-site rim FileTicket, its Harvests — with
    //    the same TEST key as its wallet; P11: by this test)
    let player = Keypair::new(); // TEST key (P12: the page's wallet, this chain only)
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let me = ix::Player {
        actor: w,
        payer: w,
        wallet: w,
    };
    let pg = r.c.page.clone();
    let sync = r.c.dir.join("page");
    let mut driver: Option<KillChild> = None;
    let (hp, hq, site, nation, target, holding) = if let Some(pg) = pg.as_ref() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(&sync).unwrap();
        std::fs::create_dir_all(&pg.out).unwrap();
        let seed_file = sync.join("player.seed");
        std::fs::write(&seed_file, hex::encode(&player.to_bytes()[..32])).unwrap();
        std::fs::set_permissions(&seed_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        driver = Some(KillChild(
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
                .expect("node (the page expedition driver)"),
        ));
        let citizen = a.citizen(&w);
        let t0 = Instant::now();
        let ticket_bell = loop {
            if let Some(cd) = r.data(&citizen) {
                let tb = le_u32(&cd, C::TICKET_BELL);
                if tb != C::NO_TICKET {
                    break tb;
                }
            }
            assert!(
                page_alive(&mut driver),
                "the driver exited before the ticket"
            );
            assert!(
                t0.elapsed() < Duration::from_secs(420),
                "the page did not file a rim ticket"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
        let plan = keeper_core::rings::rim_plan(PER_WEDGE);
        let find_home = |r: &Run<'_>| -> Option<(i32, i32, u8, Address)> {
            for &(p, q) in &plan {
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
        let joined = r.data(&citizen).unwrap()[C::FACTION];
        let plan129 = keeper_core::rings::wide_plan(FIRST_WIDE_RING, PER_WEDGE);
        let target = [(1i64, 0i64), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
            .iter()
            .map(|(dp, dq)| WideCoord::checked(hp as i64 + dp, hq as i64 + dq).unwrap())
            .find(|c| c.ring() == FIRST_WIDE_RING && plan129.contains(c))
            .unwrap_or_else(|| {
                panic!("the page's rim province ({hp}, {hq}) borders no ring-129 province keeper A opened")
            });
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
        assert!(
            page_alive(&mut driver),
            "the driver exited while harvesting"
        );
        r.lock().set_paused(true);
        (hp, hq, site, joined, target, holding)
    } else {
        let now = r.now();
        r.send(
            "Join",
            &[ix::join(&a, w, w, nation, &w, now + 30 * 86_400, None)],
            &[&player],
            "participant",
        );
        r.send(
            &format!("FileTicket(rim {hp}, {hq} site {site})"),
            &[ix::file_ticket(
                &a,
                &me,
                &[ix::Site {
                    p: hp as i16,
                    q: hq as i16,
                    site,
                }],
            )],
            &[&player],
            "participant",
        );
        let holding = a.holding(hp, hq, site);
        drive(
            r,
            &mut beacon,
            2.0,
            300,
            "keeper A settles the rim ticket",
            |r| {
                r.lock()
                    .account(&holding)
                    .is_some_and(|h| h.owner == r.c.program)
            },
        )
        .await;
        let href = ix::HoldingRef {
            p: hp as i16,
            q: hq as i16,
            site,
        };
        let final_ts = le_i64(&r.data(&holding).unwrap(), H::FINAL_TS);
        let t = final_ts.max(r.now()) + 60;
        while r.now() < t {
            drive(
                r,
                &mut beacon,
                20.0,
                120,
                "the clock passes final_ts",
                |r| r.now() >= t,
            )
            .await;
        }
        r.lock().set_paused(true);
        r.send(
            "Harvest (the lazy flip to final)",
            &[fclient::ix::v2::harvest(&a, &me, href)],
            &[&player],
            "participant",
        );
        assert_eq!(r.data(&holding).unwrap()[H::STATE], H::STATE_FINAL, "final");
        (hp, hq, site, nation, target, holding)
    };
    let href = ix::HoldingRef {
        p: hp as i16,
        q: hq as i16,
        site,
    };
    // 2. declared troops
    let mut hd = r.lock().account(&holding).unwrap();
    let ro = H::reserve(0);
    hd.data[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
    r.patch(
        holding,
        hd,
        &format!("{TROOPS} Spearmen in the rim village's reserve"),
    );

    // the route into ring 129 over the program's own masks
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let h0 = Holding::decode(&r.data(&holding).unwrap()).unwrap();
    let host_id = fclient::addr::host_id(hp, hq, site, h0.gen, h0.host_seq).unwrap();
    let host = resolver
        .legacy_host_ref(host_id)
        .expect("the legacy host ref");
    let home_key = host.key();
    let dest = ProvinceKey::new(home_key.world(), target);
    let dest_key = adr(frontier_abi::world_index::land::province_address(
        &ctx, target,
    ));
    let lands = vec![
        steps::masks_of(home_key, &r.data(&a.province(hp, hq)).unwrap()),
        steps::masks_of(
            dest,
            &r.data(&dest_key)
                .expect("the ring-129 province keeper A opened"),
        ),
    ];
    let home_pv = Province::decode(&r.data(&a.province(hp, hq)).unwrap()).unwrap();
    let route = (0..61u8)
        .filter(|t| home_pv.passable_mask & (1u64 << t) != 0)
        .filter_map(|t| {
            let o = TileAddress::new(home_key, t).ok()?;
            steps::derive_route(o, dest, &lands).map(|rt| (t, rt))
        })
        .min_by_key(|(_, rt)| rt.dirs.len())
        .expect("a passable route from the home province into ring 129");
    let (start, route) = route;
    let upper = steps::travel_upper(&route.steps, &lands);
    let dest_region = WideProvince::read(&r.data(&dest_key).unwrap())
        .unwrap()
        .region;
    // the Depart bell: the latest whose earliest arrival (the slowest doctrine) is bell 21
    let depart_t = |b: u32| genesis_ts + 600 * b as i64 + 30;
    let depart_bell = (ARRIVE_BELL.saturating_sub(70)..=ARRIVE_BELL - 2)
        .rev()
        .find(|&b| {
            permutation_rules::frontier::travel::earliest_arrival_bell(
                genesis_ts,
                depart_t(b),
                upper,
            ) <= ARRIVE_BELL
        })
        .expect("a Depart bell for the arrival bell 21");
    assert!(
        r.bell() < depart_bell,
        "bell {} is past the Depart bell {depart_bell}",
        r.bell()
    );

    // 3. resident home, Muster onto the route's start tile
    drive(
        r,
        &mut beacon,
        10.0,
        600,
        "keeper A resolves the home province to the current bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);
    let muster = if pg.is_some() {
        // P12: the page musters (its village screen's own Muster), on the test's word
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
            .is_some_and(|v| v.entries.iter().any(|e| e.id == host_id))
        {
            assert!(
                page_alive(&mut driver),
                "the driver exited before the muster landed"
            );
            assert!(
                t0.elapsed() < Duration::from_secs(240),
                "the page's Muster did not land (host {host_id})"
            );
            beacon.tick(r);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        r.lock().set_paused(true);
        json!({"tx": format!("Muster {TROOPS} onto tile {start}"), "by": "the page (wallet-signed)", "ok": true, "bell": r.bell()})
    } else {
        r.send(
            &format!("Muster {TROOPS} onto tile {start}"),
            &[ix::muster(&a, &me, href, 0, TROOPS, start)],
            &[&player],
            "participant",
        )
    };
    assert!(r.bell() < depart_bell, "mustered too late");
    drive(
        r,
        &mut beacon,
        40.0,
        1500,
        "five minutes before the Depart bell",
        |r| r.now() >= depart_t(depart_bell) - 330,
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
                r.bell() <= depart_bell,
                "the Depart bell {depart_bell} passed before the home was resident"
            );
            r.now() >= depart_t(depart_bell)
                && r.province_of(hp, hq)
                    .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);

    // 4. ONE ExpeditionDepart, sealed to the real round T(21)
    let sd = r.season();
    let season = fclient::decode::Season::decode(&sd).unwrap();
    let clock = fclient::clock::SeasonClock::from_season(&season);
    assert_eq!(
        clock.tlock_round(ARRIVE_BELL),
        ARRIVE_ROUND,
        "T(21) is the real round"
    );
    let tip = fclient::fees::min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let (path_len, path_bits) =
        permutation_rules::frontier::seal::encode_path(&route.dirs).unwrap();
    let plain = WidePlain {
        version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: ARRIVE_BELL,
        dest,
        dest_tile: route.dest_tile,
        stance: 0,
        retreat_bps: 0,
        path_len,
        path: path_bits,
        reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES],
    };
    let qn = fclient::beacon::quicknet_info();
    let sealed =
        fclient::wide_seal::seal_wide(&plain, &host, ARRIVE_BELL, &qn.public_key, ARRIVE_ROUND)
            .unwrap();
    let draft = Draft::for_wallet(
        &ctx,
        host,
        home_key,
        w,
        w,
        0,
        ARRIVE_BELL,
        tip,
        sealed.commit,
        sealed.seal,
    )
    .expect("the canonical Depart draft");
    let since = r.lock().slot();
    let mut page_depart = Value::Null;
    let depart_row = if pg.is_some() {
        // P12 (P15): the PAGE departs — the boundary card's route check, its transaction preview, the wallet's
        // signature, `/gw/f/devnet-play/expedition/submit`; this test only names the host, the steps and the turn
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        sync_write(
            &sync,
            "go-expedition",
            &json!({"host": host_id.to_string(), "p": hp, "q": hq, "tile": start,
                    "directions": route.dirs, "arrive": ARRIVE_BELL}),
        );
        let departed = |r: &Run<'_>| {
            let read = |k: &Address| r.lock().account(k);
            steps::bridge_transit(&read, &a, &holding, 0)
                .ok()
                .flatten()
                .is_some_and(|x| x.1.state == MarchState::Departed)
        };
        let t0 = Instant::now();
        while !departed(r) {
            assert!(
                page_alive(&mut driver),
                "the driver exited before the Depart landed: {}",
                std::fs::read_to_string(sync.join("failed.txt")).unwrap_or_default()
            );
            assert!(
                t0.elapsed() < Duration::from_secs(540),
                "the page's ExpeditionDepart did not land"
            );
            assert!(
                r.bell() <= depart_bell,
                "the Depart bell {depart_bell} passed before the page departed"
            );
            beacon.tick(r);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        r.lock().set_paused(true);
        page_depart = json!({"preview": read_json(&sync, "preview.json"), "departed_wall_secs": t0.elapsed().as_secs_f64()});
        let c = r.lock();
        let l = c
            .feed(0, 1_000_000, Some(&program))
            .into_iter()
            .filter(|l| l.slot > since && l.err.is_none())
            .find(|l| {
                fclient::tx::from_wire(&l.wire)
                    .ok()
                    .is_some_and(|t| t.message.account_keys.first() == Some(&w))
            })
            .expect("the page's landed ExpeditionDepart");
        json!({"tx": format!("ExpeditionDepart → ({}, {}) tile {}, arrival bell {ARRIVE_BELL}", target.p(), target.q(), route.dest_tile),
               "by": "the page (wallet-signed, /gw/f/devnet-play/expedition/submit)", "ok": true, "compute_units": l.units, "fee": l.fee, "slot": l.slot,
               "name": super::super::ix_name(&l.wire, &program),
               "lamports_from_payer": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
    } else {
        let mut c = r.lock();
        let (blockhash, last_valid) = c.latest_blockhash();
        let obs = BlockhashObservation {
            blockhash: blockhash.to_bytes(),
            context_slot: c.slot(),
            valid: true,
            block_height: last_valid.saturating_sub(100),
            last_valid_block_height: last_valid,
        };
        let prepared = prepare_depart(
            &draft,
            Target {
                program,
                season: a.season,
                program_version: frontier_stack::operator::PLAYABLE_VERSION,
            },
            obs,
            fclient::tx::TxBudget {
                cu_limit: 400_000,
                cu_price: 0,
                loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
                heap: Some(DEPART_HEAP_FRAME),
            },
            Limits {
                max_locks: 32,
                max_writes: 16,
                min_context_slot: 0,
                min_remaining_block_heights: 2,
            },
        )
        .expect("the canonical Depart message");
        let t = fclient::tx::sign(prepared.message().clone(), &[&player]).unwrap();
        let before = c.balance(&w);
        let sig = c.submit(&fclient::tx::wire(&t)).expect("submitted");
        c.produce_block();
        let l = c.transaction(&sig).cloned().expect("landed");
        assert_eq!(l.err, None, "the real ExpeditionDepart: {:?}", l.logs);
        json!({"tx": format!("ExpeditionDepart → ({}, {}) tile {}, arrival bell {ARRIVE_BELL}", target.p(), target.q(), route.dest_tile),
               "by": "participant", "ok": true, "compute_units": l.units, "fee": l.fee, "slot": l.slot,
               "lamports_from_payer": before.saturating_sub(c.balance(&w))})
    };
    r.rows.push(depart_row.clone());
    // (verify-pr129) the page's preview total is exactly what the wallet paid for the landed Depart
    if r.c.page.is_some() {
        let shown = page_depart["preview"]["preview"]["total"]
            .as_str()
            .and_then(|t| t.parse::<u64>().ok());
        assert_eq!(
            shown,
            depart_row["lamports_from_payer"].as_u64(),
            "the preview's total is the wallet's payment: {page_depart:#} {depart_row:#}"
        );
    }
    let external = steps::external_of(&a, &holding, 0);
    let transit = |r: &Run<'_>| {
        let read = |k: &Address| r.lock().account(k);
        steps::bridge_transit(&read, &a, &holding, 0)
            .ok()
            .flatten()
            .map(|x| x.1)
    };
    assert_eq!(transit(r).map(|t| t.state), Some(MarchState::Departed));
    let depart_wall = Instant::now();

    // 5. keeper A, nothing sent by the test
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A resolves the origin bell and sends SettleOrigin",
        |r| transit(r).is_some_and(|t| t.state != MarchState::Departed),
    )
    .await;
    let mut restarts = 0u32;
    restart_keeper(r, &mut restarts, "after SettleOrigin landed");
    let anchor = adr(ctx.bell_anchor(ARRIVE_BELL, dest_region));
    drive(
        r,
        &mut beacon,
        10.0,
        1500,
        "keeper A posts THE anchor of bell 21 from the real round",
        |r| r.data(&anchor).is_some(),
    )
    .await;
    let ad = r.data(&anchor).unwrap();
    let anchor_round = u64::from_le_bytes(ad[BA::ROUND..BA::ROUND + 8].try_into().unwrap());
    assert_eq!(
        anchor_round, ARRIVE_ROUND,
        "the arrival bell is anchored on the real round"
    );
    let slots: Vec<Address> = (0..4u8)
        .map(|i| adr(arrival_slot_address(&ctx, dest, ARRIVE_BELL, nation, i)))
        .collect();
    drive(
        r,
        &mut beacon,
        3.0,
        1200,
        "keeper A reveals the expedition (a wide ArrivalSlot of bell 21)",
        |r| slots.iter().any(|s| r.data(s).is_some()),
    )
    .await;
    restart_keeper(r, &mut restarts, "after the Reveal landed");
    let rn_dest = |r: &Run<'_>| {
        let read = |k: &Address| r.lock().account(k);
        steps::resolved_next_at(&read, &a, &dest_key).unwrap_or(0)
    };
    drive(
        r,
        &mut beacon,
        6.0,
        1800,
        "keeper A catches the destination up and resolves the arrival bell",
        |r| rn_dest(r) > ARRIVE_BELL,
    )
    .await;
    restart_keeper(
        r,
        &mut restarts,
        "after the arrival's Resolve, before SettleMember",
    );
    let ci = adr(clash_inputs_address(&ctx, dest, ARRIVE_BELL));
    let position = {
        let i = slots.iter().position(|s| r.data(s).is_some()).unwrap() as u8;
        nation * 4 + i
    };
    let settled = |r: &Run<'_>| {
        r.data(&ci)
            .and_then(|d| WideClashInputsHdr::read(&d).ok())
            .is_some_and(|h| h.settled_mask & (1 << position) != 0)
    };
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A sends SettleMember",
        settled,
    )
    .await;
    r.lock().set_paused(true);
    let inputs = r.data(&ci).unwrap();
    let row = WideArrival::read_at(&inputs, position as usize)
        .unwrap()
        .expect("the arrival's row");
    assert_eq!(row.host, host, "the row is the participant's host");
    assert_eq!(
        row.fate,
        wide_arrival::FATE_STAYS,
        "the host STAYS on ring 129 (fate {})",
        row.fate
    );
    let dest_bytes = r.data(&dest_key).unwrap();
    let host_bytes = host.to_bytes();
    let resident_at_dest = dest_bytes
        .windows(host_bytes.len())
        .any(|w| w == host_bytes);
    // (the host's entry at the destination: its roster names the full host reference)
    let roster = adr(frontier_abi::world_index::roster::roster_address(
        &ctx, dest,
    ));
    let in_roster = r
        .data(&roster)
        .is_some_and(|d| d.windows(host_bytes.len()).any(|w| w == host_bytes));
    let expedition_wall = depart_wall.elapsed().as_secs_f64();
    let after_settle_slot = r.lock().slot();
    let keeper_steps = program_rows(r, since);

    // 6. keeper A keeps every duty afterwards: three more bells of folds / resolves, the guard not latched
    let bell_after = r.bell();
    drive(
        r,
        &mut beacon,
        10.0,
        900,
        "three more bells after the settlement",
        |r| r.bell() >= bell_after + 3,
    )
    .await;
    r.lock().set_paused(true);
    let after_rows = program_rows(r, after_settle_slot);
    let keeper_ok_after: Vec<&Value> = after_rows.iter().filter(|x| x["ok"] == true).collect();
    assert!(
        keeper_ok_after.iter().any(|x| x["tx"]
            .as_str()
            .is_some_and(|t| t.contains("Fold") || t.contains("Skip") || t.contains("Resolve"))),
        "keeper A folds / resolves after the expedition: {after_rows:#?}"
    );
    let status = super::keeper_status(war.0, &war.1).expect("keeper A's status");
    for idx in ["land", "play"] {
        let f = &status["discovery"][idx];
        assert_eq!(f["state"], "legacy", "{idx}: {f}");
        assert_eq!(f["blocker"], Value::Null, "{idx}: {f}");
        for k in [
            "EXPEDITION_DEPART",
            "EXPEDITION_SETTLE_ORIGIN",
            "EXPEDITION_REVEAL",
            "EXPEDITION_GATHER",
            "EXPEDITION_SETTLE_MEMBER",
        ] {
            assert!(
                f["wide_accounted"][k].as_u64().unwrap_or(0) >= 1,
                "{idx}: {k} applied: {f}"
            );
        }
    }

    // 7. P9 (devnet-p15-p9): a wide village musters on later bells (keeper A's `wide-resolve` role)
    let p9 =
        wide_village_musters_later(r, &mut beacon, &player, (hp, hq, site), target, &war).await;

    // P12: the page shows the end, then says what it did (done.json: the preview, the reload, every POST)
    let page_done = if let Some(pg) = pg.as_ref() {
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        sync_write(&sync, "go-final", &json!({"fate": "stays"}));
        let t0 = Instant::now();
        while !sync.join("done.json").exists() {
            assert!(
                page_alive(&mut driver),
                "the driver exited before done.json: {}",
                std::fs::read_to_string(sync.join("failed.txt")).unwrap_or_default()
            );
            assert!(
                t0.elapsed() < Duration::from_secs(300),
                "no done.json from the page driver"
            );
            beacon.tick(r);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        r.lock().set_paused(true);
        let done = read_json(&sync, "done.json");
        let _ = std::fs::copy(sync.join("done.json"), pg.out.join("done.json"));
        assert_eq!(done["ok"], true, "the page's run: {done:#}");
        assert_eq!(done["status"], "confirmed", "{done:#}");
        assert_eq!(
            done["reveal_kept"], true,
            "the reveal half survives the reload: {done:#}"
        );
        assert_eq!(done["secret_posted"], false, "{done:#}");
        let submits = done["posts"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter(|p| {
                        p["path"]
                            .as_str()
                            .is_some_and(|x| x.ends_with("/expedition/submit"))
                    })
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(submits, 1, "ONE expedition submit: {done:#}");
        json!({"depart": page_depart, "done": done, "reloaded": read_json(&sync, "reloaded.json")})
    } else {
        Value::Null
    };

    // the verifier judges the whole season (the pinned .so given for VX's re-execution)
    let tag = if r.c.page.is_some() { "p12" } else { "p11" };
    let verdict = r.judge_season(tag);

    let wanted = [
        "ExpeditionSettleOrigin",
        "ExpeditionReveal",
        "ExpeditionGather",
        "SettleMember",
    ];
    for k in wanted {
        assert!(
            keeper_steps
                .iter()
                .any(|x| x["ok"] == true && x["tx"].as_str().is_some_and(|t| t.contains(k))),
            "keeper A landed {k}: {keeper_steps:#?}"
        );
    }
    // (verify-pr121) every keeper step landed ONCE, no expedition write failed (restarts included)
    let landed = |k: &str| {
        keeper_steps
            .iter()
            .filter(|x| x["ok"] == true && x["tx"].as_str().is_some_and(|t| t.contains(k)))
            .count()
    };
    let exp_failed: Vec<&Value> = keeper_steps
        .iter()
        .filter(|x| {
            x["ok"] != true
                && x["tx"]
                    .as_str()
                    .is_some_and(|t| t.contains("Expedition") || t.contains("SettleMember"))
        })
        .collect();
    let once = json!({"restarts": restarts, "settle_origin": landed("ExpeditionSettleOrigin"), "reveal": landed("ExpeditionReveal"),
                      "settle_member": landed("SettleMember"), "gather": landed("ExpeditionGather"), "expedition_failed": exp_failed});
    eprintln!("p11: exactly-once {once}");
    assert_eq!(
        (
            landed("ExpeditionSettleOrigin"),
            landed("ExpeditionReveal"),
            landed("SettleMember")
        ),
        (1, 1, 1),
        "{once}"
    );
    assert!(exp_failed.is_empty(), "{once}");
    let out = json!({"exactly_once": once, "p11_expedition": "a test participant's rim → wide expedition on the devnet .so: ONE ExpeditionDepart; keeper A sends every later step",
        "plan": {"home": [hp, hq], "site": site, "nation": nation, "target": [target.p(), target.q()], "dest_region": dest_region,
                 "route": {"start_tile": start, "dirs": route.dirs, "dest_tile": route.dest_tile, "travel_upper_secs": upper},
                 "depart_bell": depart_bell, "arrive_bell": ARRIVE_BELL, "external": external.to_string()},
        "muster": muster, "depart": depart_row, "keeper_steps_after_depart": keeper_steps,
        "outcome": {"fate": row.fate, "stays": row.fate == wide_arrival::FATE_STAYS, "host_in_destination_province": resident_at_dest, "host_in_destination_roster": in_roster,
                    "destination_resolved_next": rn_dest(r), "wall_secs_depart_to_settle": expedition_wall},
        "after": {"bells": 3, "keeper_rows": after_rows.len(), "keeper_ok": keeper_ok_after.len(),
                  "feed": {"land": status["discovery"]["land"], "play": status["discovery"]["play"]},
                  "expeditions_role": status["duties"]["expeditions"]},
        "p9_wide_village_musters_later": p9, "p12_page": page_done,
        "verifier": verdict, "rows": r.rows.clone(), "declared_patches": r.patches.clone(), "setup": extra});
    if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
        let _ = std::fs::write(
            std::path::Path::new(&d).join(format!("{tag}-flow.json")),
            serde_json::to_string_pretty(&out).unwrap(),
        );
    }
    assert_eq!(
        out["verifier"]["fails"], 0,
        "the verifier FAILs the season (see p11-flow.json `verifier.not_warn`)"
    );
    out
}

/// P9 (devnet-p15-p9; devnet runbook gap P9): after the expedition, the participant's WIDE VILLAGE — a slot-2
/// WideClaimSite from its rim village into a ring-129 province keeper A opened (not the expedition's destination, so
/// its province is found through the claim, not through the expedition's records) — settled and finalized by keeper
/// A's `wide-tickets` role; then, with NO declared `resolved_next` (P6 had to declare it), keeper A's `wide-resolve`
/// role keeps the province resolved, and **WideMuster lands on later bells** (`proc/wide.rs muster_as`:
/// `resident_ok(resolved_next, now_bell)`). Declared: the rim anchor's stores (the settler cost) and 400 Spearmen in
/// the wide village's reserve (as P6), and the bells' beacon state (as everywhere in P11).
pub(super) async fn wide_village_musters_later(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    player: &Keypair,
    (hp, hq, site): (i32, i32, u8),
    avoid: WideCoord,
    war: &(u16, String),
) -> Value {
    use frontier_abi::layout::player::accrual as AC;
    use frontier_abi::world_index::roster as wro;
    use permutation_rules::frontier::holding::RESOURCES;
    const STORES: i64 = 5_000_000_000;
    const MUSTER: u32 = 100;
    /// The bells the wide village's province is followed for after its first muster (the second muster's bell).
    const LATER_BELLS: u32 = 4;
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let w = player.pubkey();
    let citizen = a.citizen(&w);
    let anchor = a.holding(hp, hq, site);
    let anchor_p = a.province(hp, hq);
    r.lock().set_paused(true);
    // 1. Declared: the rim anchor's stores (the slot-2 settler cost; natural production would take days).
    let mut hd = r.lock().account(&anchor).expect("the rim village");
    for res in 0..RESOURCES {
        let so = H::store(res);
        hd.data[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&STORES.to_le_bytes());
        let cap = i64::from_le_bytes(hd.data[so + AC::CAP..so + AC::CAP + 8].try_into().unwrap());
        if cap < STORES {
            hd.data[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&STORES.to_le_bytes());
        }
    }
    r.patch(
        anchor,
        hd,
        "the rim village's stores filled (the slot-2 settler cost)",
    );
    // 2. REAL, the participant: WideClaimSite slot 2 into a ring-129 province keeper A opened.
    let tk = adr(wt::ticket_address(&ctx, &citizen.to_bytes()));
    let claim_ix = |c: WideCoord, s: u8| {
        wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(w, true),
                AccountMeta::new(w, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new_readonly(a.frontier(), false),
                AccountMeta::new(adr(wl::province_address(&ctx, c)), false),
                AccountMeta::new(tk, false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::ClaimSite {
                p: c.p(),
                q: c.q(),
                site: s,
                slot: 2,
            }
            .to_bytes()
            .to_vec(),
        )
    };
    let home = WideCoord::checked(hp as i64, hq as i64).unwrap();
    let mut near = keeper_core::rings::wide_plan(FIRST_WIDE_RING, PER_WEDGE);
    // (the expedition's destination last: its cursor is the expeditions role's until the arrival)
    near.sort_by_key(|c| (*c == avoid, c.distance(home)));
    let mut found = None;
    let mut last_err = String::new();
    'outer: for c in near.iter().take(8) {
        for s in 0..16u8 {
            match r.simulate_ok(&[claim_ix(*c, s)], &[player]) {
                Ok(_) => {
                    found = Some((*c, s));
                    break 'outer;
                }
                Err(e) => last_err = e,
            }
        }
    }
    let (c, s) = found.unwrap_or_else(|| panic!("no slot-2 wide claim fits ({last_err})"));
    let claim = r.send(
        &format!(
            "WideClaimSite({}, {} site {s}, slot 2) from the rim village",
            c.p(),
            c.q()
        ),
        &[claim_ix(c, s)],
        &[player],
        "participant",
    );
    let rec = WideTicket::read(&r.data(&tk).unwrap()).expect("a wide ticket");
    assert_eq!(rec.status, TicketStatus::Open);
    let wholding = adr(wh::holding_address(&ctx, c, s));
    let wprov = adr(wl::province_address(&ctx, c));
    let wp = WideProvince::read(&r.data(&wprov).unwrap()).expect("the wide province");
    let pkey = ProvinceKey::new(wp.world, c);
    // 3. REAL, keeper A's `wide-tickets`: WideSettleTicket on the bell's (declared) seed, then WideFinalize.
    drive(
        r,
        beacon,
        4.0,
        900,
        "keeper A's wide-tickets role settles the wide claim",
        |r| {
            r.lock()
                .account(&wholding)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    r.lock().set_paused(true);
    let wfinal_ts = le_i64(&r.data(&wholding).unwrap(), H::FINAL_TS);
    if r.now() < wfinal_ts {
        r.advance_exact(wfinal_ts + 1);
    }
    drive(
        r,
        beacon,
        4.0,
        900,
        "keeper A's wide-tickets role finalizes the wide village",
        |r| {
            r.data(&wholding)
                .is_some_and(|h| h[H::STATE] == H::STATE_FINAL)
        },
    )
    .await;
    r.lock().set_paused(true);
    // 4. Declared: 400 Spearmen in the wide village's reserve (as P6). NOT declared: the province's resolved_next.
    let mut whd = r.lock().account(&wholding).unwrap();
    let ro = H::reserve(0);
    whd.data[ro..ro + 4].copy_from_slice(&400u32.to_le_bytes());
    r.patch(wholding, whd, "400 Spearmen in the wide village's reserve");
    let rn = |r: &Run<'_>| {
        let read = |k: &Address| r.lock().account(k);
        steps::resolved_next_at(&read, &a, &wprov).unwrap_or(0)
    };
    let at_final = json!({"bell": r.bell(), "resolved_next": rn(r), "opened_bell": wp.opened_bell});
    let muster_ix = |troops: u32, tile: u8| {
        wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(w, true),
                AccountMeta::new(w, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new(wholding, false),
                AccountMeta::new(wprov, false),
                AccountMeta::new(adr(wro::roster_address(&ctx, pkey)), false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::Muster {
                unit: 0,
                troops,
                tile,
            }
            .to_bytes()
            .to_vec(),
        )
    };
    let passable = |r: &Run<'_>| {
        let pd = r.data(&wprov).unwrap();
        u64::from_le_bytes(
            pd[PV::PASSABLE_MASK..PV::PASSABLE_MASK + 8]
                .try_into()
                .unwrap(),
        )
    };
    let probe = |r: &Run<'_>| {
        let m = passable(r);
        let mut last = String::new();
        for t in (0..64u8).filter(|t| m & (1u64 << t) != 0) {
            match r.simulate_ok(&[muster_ix(MUSTER, t)], &[player]) {
                Ok(_) => return Ok(t),
                Err(e) => last = e,
            }
        }
        Err(last)
    };
    // (the program's own verdict at this moment, whatever it is: a lagging province answers NotResident)
    let probe_at_final = match probe(r) {
        Ok(t) => json!({"ok": true, "tile": t}),
        Err(e) => json!({"ok": false, "err": e}),
    };
    // (verify-pr129) the control: the program refuses the muster NotResident (26) exactly while the cursor lags
    let lagging = !fclient::play::resident_ok(rn(r), r.bell());
    let refused_26 = probe_at_final["ok"] == false
        && probe_at_final["err"]
            .as_str()
            .is_some_and(|e| e.contains("Custom(26)"));
    assert_eq!(
        refused_26, lagging,
        "NotResident iff the province lags: {at_final} {probe_at_final}"
    );
    eprintln!("p9: control at finalization lagging={lagging} refused_26={refused_26}");
    // 5. REAL, keeper A's `wide-resolve`: the province resolved until resident; the first WideMuster.
    let t0 = Instant::now();
    drive(
        r,
        beacon,
        4.0,
        1500,
        "keeper A's wide-resolve role brings the wide village's province to resident",
        |r| fclient::play::resident_ok(rn(r), r.bell()),
    )
    .await;
    r.lock().set_paused(true);
    let catch_up_wall = t0.elapsed().as_secs_f64();
    let tile = probe(r).unwrap_or_else(|e| panic!("no tile takes the first wide muster: {e}"));
    let b1 = r.bell();
    let muster1 = r.send(
        &format!("WideMuster {MUSTER} onto tile {tile} (bell {b1})"),
        &[muster_ix(MUSTER, tile)],
        &[player],
        "wide village owner",
    );
    // 6. LATER_BELLS more bells: at each bell's end the province is still resident (keeper A keeps it within a bell);
    //    then the second WideMuster, on a bell no declared state stands in for.
    let mut timeline = vec![];
    for b in b1 + 1..=b1 + LATER_BELLS {
        drive(
            r,
            beacon,
            6.0,
            900,
            &format!("bell {b}, the wide village's province resident"),
            |r| r.bell() >= b && fclient::play::resident_ok(rn(r), r.bell()),
        )
        .await;
        r.lock().set_paused(true);
        timeline.push(json!({"bell": r.bell(), "resolved_next": rn(r), "chain_ts": r.now()}));
    }
    let tile2 = probe(r).unwrap_or_else(|e| panic!("no tile takes the later wide muster: {e}"));
    let b2 = r.bell();
    assert!(b2 >= b1 + LATER_BELLS);
    let muster2 = r.send(
        &format!(
            "WideMuster {MUSTER} onto tile {tile2} (bell {b2}, {} bells later)",
            b2 - b1
        ),
        &[muster_ix(MUSTER, tile2)],
        &[player],
        "wide village owner",
    );
    let st = super::keeper_status(war.0, &war.1).expect("keeper A's status");
    let role = st["duties"]["wide_resolve"].clone();
    assert!(
        role["landed"].as_u64().unwrap_or(0) >= LATER_BELLS as u64,
        "keeper A's wide-resolve role landed its resolves: {role:#}"
    );
    for idx in ["land", "play"] {
        assert_eq!(
            st["discovery"][idx]["state"], "legacy",
            "{idx}: {:#}",
            st["discovery"][idx]
        );
    }
    json!({
        "gap": "P9: a wide village musters on later bells; keeper A's wide-resolve role keeps its province resolved (no declared resolved_next)",
        "wide_village": {"p": c.p(), "q": c.q(), "site": s, "claim": claim, "ticket_bell": rec.bell},
        "at_final": at_final, "muster_probe_at_final": probe_at_final, "catch_up_wall_secs": catch_up_wall,
        "muster_first": muster1, "timeline": timeline, "muster_later": muster2,
        "keeper_wide_resolve_role": role,
    })
}

fn sync_write(dir: &std::path::Path, name: &str, v: &Value) {
    std::fs::write(dir.join(name), v.to_string()).unwrap();
}

fn read_json(dir: &std::path::Path, name: &str) -> Value {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// Whether the page driver (if any) still runs.
fn page_alive(d: &mut Option<KillChild>) -> bool {
    d.as_mut()
        .is_none_or(|d| d.0.try_wait().ok().flatten().is_none())
}
