//! PPROV (devnet-open-province, D-devnet-rim-homes-2): who opens the provinces a nation grows into on the devnet
//! wide season.
//!
//! `S1_DEVNET_WIDE_7D` runs keeper A's rings duty with `lazy_provinces`: rings past the genesis rings 0–3 are opened
//! and seeded WITHOUT their provinces. Every second or third village is a FileOutpost, which the program allows only
//! at ring > `heartland_max_ring` (3), within `outpost_range` (3) of the home, into a PRESENT Province; a ⑭ R3 home
//! past the heartland needs one too. Before this run nothing but the rim/wide duties opened any province past ring 3.
//! Here keeper A runs as the devnet profile now says (`provinces_reach` 3 in its rings duty), and:
//!
//! 1. **Declared patch**: RingSeed(4..=10) seeded (copies of the genesis ring 3's, `d` set; on devnet the rings
//!    duty's ExtendFrontier / OpenRing / ConsumeRingSeed seed them one a bell, as P3/P4 show for the genesis and
//!    the rim) — after (0) the map growth P4 declares.
//! 2. REAL, the participant's home (P3's PlaceHome in a ring 2–3 heartland province) turned final by its own
//!    Harvest (the lazy flip); then a FileOutpost into an absent ring-4+ province within reach is REFUSED
//!    (`BadAccount`, the Province is absent): the gap, on the exact devnet `.so`.
//! 3. REAL, keeper A: the `provinces_reach` duty opens every absent province of a seeded ring within 3 of the
//!    settled home (OpenProvince, rent from the wedge funds), and nothing farther.
//! 4. REAL, the participant: Harvest until the settler cost is met, then FileOutpost into the province keeper A
//!    opened; **declared** anchor + seed of the ticket bell (as P4); REAL keeper A `tickets` role: SettleTicket →
//!    the participant's second village (order 2).
//! 5. REAL, keeper A: the new village's province is settled, so the provinces within 3 of it open too.
//!
//! Every OpenProvince's compute units, fee and the wedge fund's rent are recorded.
//!
//! **PFLOOR** (keeper-rent-floor, D-verify-pr144-1; [`Input::floor`]): the same world on a localnet whose Rent
//! sysvar is set to `rate` lamports/byte (5,080 or 6,960). After step 1, every wedge fund is **declared** (patched)
//! to its rent + keeper A's fund floor at that rate + 2½ provinces' rent. keeper A must read the cluster's rate (its
//! `/v1/status` `duties.rent`), open exactly `min(2, wanted)` provinces in each wedge, then wait "at its floor",
//! and open nothing more; each open costs the fund one province's rent **at the cluster's rate**. With the old
//! fixed-5,080 floor, a 6,960 fund patched this way would have let keeper A open every wanted province.

use super::*;

/// What [`flow`] needs from P3's setup: the participant and its first home.
pub struct Input {
    pub player: Keypair,
    pub home: (i32, i32, u8),
    pub reach: u32,
    /// PFLOOR: the cluster's rate and keeper A's API / config (else PPROV).
    pub floor: Option<Floor>,
}

/// PFLOOR's inputs.
#[derive(Clone)]
pub struct Floor {
    /// The localnet's Rent sysvar rate (lamports/byte).
    pub rate: u64,
    pub keeper_api: u16,
    pub token: String,
    /// keeper A's `keeper.toml` (the floor is computed from the config it runs with).
    pub keeper_toml: std::path::PathBuf,
}

/// Provinces each wedge fund is patched to afford above its floor (plus half of one more).
const FLOOR_ROOM: u64 = 2;

/// The rings this run declares seeded (past the genesis ring 3).
const SEEDED: std::ops::RangeInclusive<u16> = 4..=10;

fn disc(c: ProvinceCoord, r: u32) -> Vec<ProvinceCoord> {
    let r = r as i32;
    let mut v = vec![];
    for dp in -r..=r {
        for dq in (-r).max(-dp - r)..=r.min(-dp + r) {
            v.push(ProvinceCoord::new(c.p + dp, c.q + dq));
        }
    }
    v
}

pub(super) async fn flow(r: &mut Run<'_>, inp: Input) -> Value {
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let g = sd[S::GENESIS_RING];
    let (_, _, _, genesis_ts) = r.clock();
    assert_eq!(cq.heartland_max_ring, 3);
    assert_eq!(
        cq.outpost_range as u32, inp.reach,
        "the profile's reach is the preset's outpost_range"
    );
    let (hp, hq, hsite) = inp.home;
    let home = ProvinceCoord::new(hp, hq);
    let w = inp.player.pubkey();
    let me = ix::Player {
        actor: w,
        payer: w,
        wallet: w,
    };
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let hpd = r.data(&a.province(hp, hq)).expect("the home province");
    let home_used = hpd[PV::N_SITES_USED];
    assert!(home_used > 0, "PlaceHome counts the home's site as used");

    // keeper A's genesis duty finishes the genesis rings' own provinces first (P3 waits only for the ring count).
    // (and the rim's plan, whose rent comes out of the same wedge funds)
    let mut genesis: Vec<ProvinceCoord> = (0..=u32::from(g))
        .flat_map(permutation_rules::frontier::geometry::ring_provinces)
        .collect();
    genesis.extend(
        keeper_core::rings::rim_plan(PER_WEDGE)
            .into_iter()
            .map(|(p, q)| ProvinceCoord::new(p, q)),
    );
    r.run_until(
        3.0,
        240,
        "keeper A opens every genesis and rim province",
        |r| {
            genesis
                .iter()
                .all(|c| r.lock().account(&r.c.a.province(c.p, c.q)).is_some())
        },
    )
    .await;
    r.lock().set_paused(true);
    // What the season looked like before: every province past the genesis rings, absent (except P4's rim plan).
    let target_cands: Vec<ProvinceCoord> = {
        let mut v: Vec<ProvinceCoord> = disc(home, inp.reach)
            .into_iter()
            .filter(|c| c.ring() > u32::from(g))
            .collect();
        v.sort_by_key(|c| (home.distance(*c), c.ring(), c.p, c.q));
        v
    };
    assert!(!target_cands.is_empty());
    for c in &target_cands {
        assert!(
            r.lock().account(&a.province(c.p, c.q)).is_none(),
            "({}, {}) absent before",
            c.p,
            c.q
        );
    }
    let funds = |r: &Run<'_>| -> Vec<u64> {
        (0..6u8)
            .map(|w| r.lock().balance(&adr(r.ctx().province_fund(w))))
            .collect()
    };

    // 2. The home final (its Harvest's lazy flip), then the gap: FileOutpost into an absent province is refused.
    let holding = a.holding(hp, hq, hsite);
    let hd = r.data(&holding).expect("the home");
    let final_ts = le_i64(&hd, H::FINAL_TS);
    let hold_ref = ix::HoldingRef {
        p: hp as i16,
        q: hq as i16,
        site: hsite,
    };
    let mut t = final_ts.max(r.now()) + 600;
    r.advance_exact(t);
    let mut harvests = vec![r.send(
        "Harvest (home)",
        &[fclient::ix::v2::harvest(&a, &me, hold_ref)],
        &[&inp.player],
        "participant",
    )];
    let hd = r.data(&holding).unwrap();
    assert_eq!(hd[H::STATE], H::STATE_FINAL, "the lazy flip");
    let gen = hd[H::GEN];
    let key = frontier_abi::addr::host_id(hp, hq, hsite, gen, 0).expect("the anchor key");
    let outpost_ix = |c: ProvinceCoord, site: u8| {
        fclient::ix::v2::file_outpost(
            &a,
            &me,
            &[ix::Site {
                p: c.p as i16,
                q: c.q as i16,
                site,
            }],
            hold_ref,
            key,
        )
    };
    let target = target_cands[0];
    let before = r.simulate_ok(&[outpost_ix(target, 0)], &[&inp.player]);
    let gap_err = before.expect_err("FileOutpost into an absent province must be refused");
    assert!(
        gap_err.contains("Custom") || gap_err.contains("code"),
        "{gap_err}"
    );

    // 1. Declared: RingSeed(4..=10) seeded.
    let rs3 = r
        .lock()
        .account(&adr(ctx.ring_seed(u16::from(g))))
        .expect("the genesis ring 3's RingSeed");
    assert_eq!(rs3.data[RS::STATUS], RS::STATUS_SEEDED);
    for d in SEEDED {
        let mut rs = rs3.clone();
        rs.data[RS::D..RS::D + 2].copy_from_slice(&d.to_le_bytes());
        r.patch(
            adr(ctx.ring_seed(d)),
            rs,
            &format!("RingSeed({d}) seeded (the genesis ring 3's seed)"),
        );
    }
    if let Some(fl) = inp.floor.clone() {
        return floor_flow(r, &inp, fl, &target_cands, g).await;
    }
    let funds0 = funds(r);
    let since = r.lock().slot();

    // 3. keeper A opens the provinces within reach of the settled home, and nothing farther.
    let want: Vec<ProvinceCoord> = target_cands
        .iter()
        .copied()
        .filter(|c| SEEDED.contains(&(c.ring() as u16)))
        .collect();
    let t_open = Instant::now();
    r.run_until(
        3.0,
        300,
        "keeper A opens the provinces next to the settled home",
        |r| {
            want.iter()
                .all(|c| r.lock().account(&r.c.a.province(c.p, c.q)).is_some())
        },
    )
    .await;
    let open_secs = t_open.elapsed().as_secs_f64();
    r.lock().set_paused(true);
    let opens1: Vec<Value> = r
        .feed_rows(since, &[fclient::abi::tag::OPEN_PROVINCE], "keeper A")
        .into_iter()
        .filter(|x| {
            let c = ProvinceCoord::new(
                x["p"].as_i64().unwrap() as i32,
                x["q"].as_i64().unwrap() as i32,
            );
            c.ring() > u32::from(g) && c.ring() < u32::from(R_MAX_HARD)
        })
        .collect();
    let ok1: Vec<&Value> = opens1.iter().filter(|x| x["ok"] == true).collect();
    assert_eq!(
        ok1.len(),
        want.len(),
        "exactly the provinces within reach: {opens1:#?}"
    );
    for x in &ok1 {
        let c = ProvinceCoord::new(
            x["p"].as_i64().unwrap() as i32,
            x["q"].as_i64().unwrap() as i32,
        );
        assert!(
            home.distance(c) <= inp.reach && c.ring() > u32::from(g),
            "{x}"
        );
    }
    let funds1 = funds(r);
    let rent_spent: u64 = funds0.iter().zip(&funds1).map(|(a, b)| a - b).sum();
    assert_eq!(
        rent_spent,
        want.len() as u64 * fclient::land::PROVINCE_RENT_V2,
        "each open costs the wedge fund one province's rent"
    );

    // 4. The participant's second village in a province keeper A opened.
    let mut filed = None;
    let mut last_err = String::new();
    'outer: for _ in 0..16 {
        for c in &want {
            let pd = r.data(&a.province(c.p, c.q)).unwrap();
            for s in 0..pd[PV::SITE_COUNT] {
                if !matches!(
                    pd[PV::site(s as usize) + SM::STATE],
                    SM::STATE_FREE | SM::STATE_RELEASED_FREE
                ) {
                    continue;
                }
                match r.simulate_ok(&[outpost_ix(*c, s)], &[&inp.player]) {
                    Ok(_) => {
                        filed = Some((*c, s));
                        break 'outer;
                    }
                    Err(e) => last_err = e,
                }
            }
        }
        t = t.max(r.now()) + 4 * 3_600;
        r.advance_exact(t);
        harvests.push(r.send(
            "Harvest (home)",
            &[fclient::ix::v2::harvest(&a, &me, hold_ref)],
            &[&inp.player],
            "participant",
        ));
    }
    let (oc, os) = filed.unwrap_or_else(|| panic!("no FileOutpost fits ({last_err})"));
    let file = r.send(
        &format!(
            "FileOutpost({}, {} site {os}) anchored on the home",
            oc.p, oc.q
        ),
        &[outpost_ix(oc, os)],
        &[&inp.player],
        "participant",
    );
    let cd = r.data(&a.citizen(&w)).unwrap();
    let ticket_bell = le_u32(&cd, C::TICKET_BELL);
    let region = ix::region_of(oc.p, oc.q);
    r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
    r.stage_seed(ticket_bell, region, [0x6B; 32]);
    let before_settle = r.lock().slot();
    let outpost = a.holding(oc.p, oc.q, os);
    r.run_until(
        2.0,
        180,
        "keeper A's tickets role settles the outpost",
        |r| {
            r.lock()
                .account(&outpost)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    r.lock().set_paused(true);
    let settle = r.feed_rows(
        before_settle,
        &[fclient::abi::tag::SETTLE_TICKET],
        "keeper A (tickets role)",
    );
    assert!(settle.iter().any(|x| x["ok"] == true), "{settle:#?}");
    let od = r.data(&outpost).unwrap();
    assert_eq!(od[H::ORDER], 2, "the second village");
    assert_eq!(
        adr(od[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32]
            .try_into()
            .unwrap()),
        a.citizen(&w)
    );

    // 5. The new village's province is settled now: keeper A opens the seeded provinces within reach of it.
    let since2 = r.lock().slot();
    let want2: Vec<ProvinceCoord> = disc(oc, inp.reach)
        .into_iter()
        .filter(|c| c.ring() > u32::from(g) && SEEDED.contains(&(c.ring() as u16)))
        .filter(|c| r.lock().account(&a.province(c.p, c.q)).is_none())
        .collect();
    r.run_until(
        3.0,
        300,
        "keeper A opens the provinces next to the new village",
        |r| {
            want2
                .iter()
                .all(|c| r.lock().account(&r.c.a.province(c.p, c.q)).is_some())
        },
    )
    .await;
    r.lock().set_paused(true);
    let opens2: Vec<Value> = r
        .feed_rows(since2, &[fclient::abi::tag::OPEN_PROVINCE], "keeper A")
        .into_iter()
        .filter(|x| {
            let c = ProvinceCoord::new(
                x["p"].as_i64().unwrap() as i32,
                x["q"].as_i64().unwrap() as i32,
            );
            c.ring() > u32::from(g) && c.ring() < u32::from(R_MAX_HARD)
        })
        .collect();
    let ok2 = opens2.iter().filter(|x| x["ok"] == true).count();
    assert_eq!(ok2, want2.len(), "{opens2:#?}");
    // Nothing anywhere else: every legacy province past the genesis rings is within reach of a settled one.
    let settled = [home, oc];
    let mut stray = vec![];
    for d in SEEDED {
        for c in permutation_rules::frontier::geometry::ring_provinces(u32::from(d)) {
            if r.lock().account(&a.province(c.p, c.q)).is_some()
                && !settled.iter().any(|s| s.distance(c) <= inp.reach)
            {
                stray.push((c.p, c.q));
            }
        }
    }
    assert!(stray.is_empty(), "opened beyond reach: {stray:?}");
    let funds2 = funds(r);

    let cu: Vec<u64> = ok1
        .iter()
        .map(|x| x["compute_units"].as_u64().unwrap_or(0))
        .collect();
    let fee: Vec<u64> = ok1
        .iter()
        .map(|x| x["lamports_from_payer"].as_u64().unwrap_or(0))
        .collect();
    json!({
        "mode": "pprov",
        "patches": r.patches,
        "home": {"p": hp, "q": hq, "site": hsite, "ring": home.ring(), "n_sites_used": home_used},
        "gap_before": {"file_outpost_into": {"p": target.p, "q": target.q, "ring": target.ring()}, "refused": gap_err},
        "demand_opens_home": {"count": ok1.len(), "wall_secs": open_secs, "txs": opens1,
            "compute_units_min": cu.iter().min(), "compute_units_max": cu.iter().max(),
            "keeper_lamports_per_open_min": fee.iter().min(), "keeper_lamports_per_open_max": fee.iter().max(),
            "rent_from_wedge_funds_total": rent_spent,
            "rent_per_open": fclient::land::PROVINCE_RENT_V2},
        "outpost": {"p": oc.p, "q": oc.q, "site": os, "ring": oc.ring(), "file": file, "settle": settle,
            "harvests": harvests.len()},
        "demand_opens_outpost": {"count": ok2, "txs": opens2},
        "province_funds": {"before": funds0, "after_home": funds1, "after_outpost": funds2},
        "rows": r.rows,
    })
}

/// PFLOOR (module doc): keeper A's on-demand opens stop at the fund floor of the cluster's rate.
async fn floor_flow(
    r: &mut Run<'_>,
    inp: &Input,
    fl: Floor,
    target_cands: &[ProvinceCoord],
    g: u8,
) -> Value {
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let home = ProvinceCoord::new(inp.home.0, inp.home.1);
    // The figures keeper A must use: its own config at the cluster's rate.
    let kc = keeper_core::config::KeeperConfig::from_toml(
        &std::fs::read_to_string(&fl.keeper_toml).expect("keeper.toml"),
    )
    .expect("keeper A's config");
    let rent = keeper_core::rent::KeeperRent::at_rate(fl.rate);
    let floor = keeper_core::rings::demand_fund_floor(&kc, &rent);
    let (fund_rent, prov) = (rent.land.fund, rent.land.province_v2);
    // The localnet charges that rate (the program's `init::rent`).
    assert_eq!(
        r.lock()
            .account(&adr(ctx.province_fund(0)))
            .map(|x| x.data.len()),
        Some(fclient::abi::size::PROVINCE_FUND)
    );
    let old = keeper_core::rent::KeeperRent::at_rate(5_080);
    let old_floor = keeper_core::rings::demand_fund_floor(&kc, &old);

    // Declared: every wedge fund = its rent + the floor + 2½ provinces (at the cluster's rate).
    let patched = fund_rent + floor + FLOOR_ROOM * prov + prov / 2;
    for w in 0..6u8 {
        let k = adr(ctx.province_fund(w));
        let mut acct = r.lock().account(&k).expect("the wedge fund");
        acct.lamports = patched;
        r.patch(
            k,
            acct,
            &format!(
                "ProvinceFund({w}) = rent {fund_rent} + floor {floor} + {FLOOR_ROOM}½ provinces at {} lamports/byte",
                fl.rate
            ),
        );
    }
    let want: Vec<ProvinceCoord> = target_cands
        .iter()
        .copied()
        .filter(|c| SEEDED.contains(&(c.ring() as u16)))
        .collect();
    let mut wanted = [0u64; 6];
    for c in &want {
        wanted[c.wedge().unwrap() as usize] += 1;
    }
    let expect: Vec<u64> = wanted.iter().map(|&n| n.min(FLOOR_ROOM)).collect();
    assert!(
        wanted.iter().any(|&n| n > FLOOR_ROOM),
        "some wedge wants more than the floor allows (else the run proves nothing): {wanted:?}"
    );
    // Under the old compile-time figures the same balance allows this many a wedge.
    let old_allowance = patched
        .saturating_sub(old.land.fund)
        .saturating_sub(old_floor)
        / old.land.province_v2;
    let since = r.lock().slot();
    let opened_per_wedge = |r: &Run<'_>| -> Vec<u64> {
        let mut v = vec![0u64; 6];
        for c in &want {
            if r.lock().account(&r.c.a.province(c.p, c.q)).is_some() {
                v[c.wedge().unwrap() as usize] += 1;
            }
        }
        v
    };
    let api = fl.keeper_api;
    let token = fl.token.clone();
    let at_floor = |_: &Run<'_>| -> bool {
        keeper_status(api, &token).is_some_and(|s| {
            s["duties"]["provinces_demand"]["waiting"]
                .as_str()
                .is_some_and(|w| w.contains("at its floor"))
        })
    };
    let t0 = Instant::now();
    r.run_until(
        3.0,
        300,
        "keeper A opens up to the floor and waits there",
        |r| at_floor(r) && opened_per_wedge(r) == expect,
    )
    .await;
    let secs = t0.elapsed().as_secs_f64();
    // And nothing more for several scans (`provinces_scan_slots` 10).
    let s0 = r.lock().slot();
    r.run_until(3.0, 120, "several more scans", |r| {
        r.lock().slot() >= s0 + 60
    })
    .await;
    r.lock().set_paused(true);
    let opened = opened_per_wedge(r);
    assert_eq!(
        opened, expect,
        "per wedge: min({FLOOR_ROOM}, wanted {wanted:?})"
    );
    let status = keeper_status(api, &token).expect("keeper A's status");
    let rent_status = status["duties"]["rent"].clone();
    assert_eq!(rent_status["lamports_per_byte"], fl.rate, "{rent_status}");
    assert_eq!(rent_status["usable"], true);
    let waiting = status["duties"]["provinces_demand"]["waiting"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        waiting.contains(&format!("({floor} lamports at {} lamports/byte)", fl.rate)),
        "{waiting}"
    );
    let rows: Vec<Value> = r
        .feed_rows(since, &[fclient::abi::tag::OPEN_PROVINCE], "keeper A")
        .into_iter()
        .filter(|x| {
            let c = ProvinceCoord::new(
                x["p"].as_i64().unwrap() as i32,
                x["q"].as_i64().unwrap() as i32,
            );
            c.ring() > u32::from(g) && c.ring() < u32::from(R_MAX_HARD)
        })
        .collect();
    let ok = rows.iter().filter(|x| x["ok"] == true).count() as u64;
    assert_eq!(ok, expect.iter().sum::<u64>(), "{rows:#?}");
    // A refused row may only be a later version of an open that landed (`AlreadyDone`, code 52: the keeper's
    // escalated duplicate of the same write), never a refusal for the funds.
    let landed: std::collections::BTreeSet<(i64, i64)> = rows
        .iter()
        .filter(|x| x["ok"] == true)
        .map(|x| (x["p"].as_i64().unwrap(), x["q"].as_i64().unwrap()))
        .collect();
    assert!(
        rows.iter().all(|x| x["ok"] == true
            || (x["err"].as_str().is_some_and(|e| e.contains("Custom(52)"))
                && landed.contains(&(x["p"].as_i64().unwrap(), x["q"].as_i64().unwrap())))),
        "only AlreadyDone duplicates of landed opens: {rows:#?}"
    );
    // Each open cost its wedge fund one province's rent at the cluster's rate; every fund stays above the floor,
    // and a wedge that wanted more cannot afford one more.
    let after: Vec<u64> = (0..6u8)
        .map(|w| r.lock().balance(&adr(ctx.province_fund(w))))
        .collect();
    for w in 0..6 {
        assert_eq!(after[w], patched - opened[w] * prov, "wedge {w}");
        assert!(after[w] - fund_rent >= floor, "wedge {w} above its floor");
        if wanted[w] > FLOOR_ROOM {
            assert!(
                after[w] - fund_rent < floor + prov,
                "wedge {w} cannot afford one more"
            );
        }
    }
    let _ = a;
    let _ = home;
    json!({
        "mode": "pfloor",
        "rate": fl.rate,
        "patches": r.patches,
        "home": {"p": inp.home.0, "q": inp.home.1, "ring": home.ring()},
        "keeper_rent_status": rent_status,
        "floor": floor,
        "floor_at_compile_time_5080": old_floor,
        "fund_rent": fund_rent,
        "province_rent": prov,
        "fund_patched": patched,
        "wanted_per_wedge": wanted,
        "opened_per_wedge": opened,
        "old_fixed_5080_allowance_per_wedge": old_allowance,
        "funds_after": after,
        "waiting": waiting,
        "wall_secs": secs,
        "open_txs": rows,
    })
}
