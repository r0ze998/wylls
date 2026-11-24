//! P18 (devnet-territory-dev; owner NWP-2, 2026-11-24 19:28: "create the new world only after territory is playable on
//! devnet: keeper A runs upkeep/decay, the devnet page can send claims"): player territory on the NEW devnet `.so`
//! (`OPERATOR_TERRITORY_SO`, the build of the commit under test), offline, with the devnet stack as the runbook runs it —
//! the operator's new-world profile (S1_DEVNET_TERRITORY, WideSetRules keep holder NeutralTerritoryV1), keeper A
//! (`feed = "rpc"`, the devnet profile's roles plus `territory`), the herald and the gateway in their devnet modes, and
//! the WEB PAGE as the participant (wallet-signed, wallet-paid through `/gw/f/devnet-play/act/submit`).
//!
//! P7's run first, in the territory world: the page Joins, files its rim FileTicket, harvests, and its wide claim card
//! claims the site's TILE (first press: the preview — ore + SOL —; second: one wallet-signed WideClaimTile), then the
//! VILLAGE on it (WideClaimSite naming the territory record); keeper A's `tickets` / `wide-tickets` roles settle and
//! finalize. Then this phase:
//!
//! 1. REAL, the page: 「1マス取る」 on the card's first province row — preview (JA, then the same in EN), 「署名して取る」:
//!    the wallet pays EXACTLY the preview's SOL (the records the claim creates + the fee) and the first home EXACTLY
//!    its ore. A bell later, a second tile in another province (its own record: the preview names it again).
//! 2. REAL, keeper A's `territory` role: upkeep settles (0xDC op 12) land, from keeper A's payers, every bell; the
//!    summary's `paid_to` follows the clock.
//! 3. **Declared** capture (the expedition's wide Resolve writes it on a real capture; offline the shipped rounds do
//!    not reach the arrival bells): a second participant of ANOTHER nation, its own Join and first home (REAL); the
//!    keeps of the first extra tile's province AND of the wide village's province set held by that nation with that
//!    home as the recorded captor (`land::set_captor`, a new keep generation). REAL, keeper A: WideTerritoryConquer moves
//!    the page's tile in the first province to the captor (its summary created from keeper A's payer); the village's
//!    tile stays with its village (no conquest is even planned there).
//! 4. **Declared** starvation: the first home's food store 0 and its food upkeep the kernel's maximum (stands in for an
//!    army the stores cannot feed: VQ-1, land upkeep alone never bites). REAL, keeper A: the next settle makes the land
//!    unpaid; REAL, the page: 「1マス取る」 is refused before anything is signed (JA and EN); then the clock past 24
//!    unpaid bells — REAL, keeper A: WideTerritoryDecay, the FARTHEST tile first, one a bell, until none is left.
//!
//! Asserted on chain: every page transaction one signature, the wallet fee payer; the wallet's lamports per claim equal
//! the preview; the ore burned equals the preview; the records' owners; the keeper's writes by kind (feed), and its
//! `/v1/status` territory counters. No verifier pass: the verifier does not know the territory ops yet (gap G4).
use super::*;
use frontier_abi::layout::player::accrual as AC;
use frontier_abi::world_index::territory::{self as wtr, TerritoryPlayer, TerritoryProvince};

/// Keeper A's API (its `/v1/status`).
#[derive(Clone)]
pub struct Input {
    pub keeper_api: u16,
    pub token: String,
}

/// The resource indices of territory V1 (frontier-abi TERRITORY_V1: cost in ore, upkeep in food).
const ORE: usize = 3;
const FOOD: usize = 0;
/// The declared ore of the first home (whole units × 1,000 milli): enough for every tile of this run.
const ORE_MILLI: i64 = 5_000_000;

/// (P18) The first home's ore, declared (a rim village's terrain yields none; a tile costs 10 + 2 % a tile owned).
pub(super) fn declare_ore(r: &mut Run<'_>, home: Address) {
    let mut acc = r.lock().account(&home).expect("the first home");
    let so = H::store(ORE);
    acc.data[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&ORE_MILLI.to_le_bytes());
    let cap = le_i64(&acc.data, so + AC::CAP);
    if cap < ORE_MILLI {
        acc.data[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&ORE_MILLI.to_le_bytes());
    }
    r.patch(
        home,
        acc,
        "the first home's ore (the tile price; a rim village's terrain yields none)",
    );
}

fn keeper_status(port: u16, token: &str) -> Value {
    use std::io::{Read, Write};
    let Ok(mut c) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return Value::Null;
    };
    let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if c.write_all(req.as_bytes()).is_err() {
        return Value::Null;
    }
    let mut b = String::new();
    let _ = c.read_to_string(&mut b);
    b.split("\r\n\r\n")
        .nth(1)
        .and_then(|x| serde_json::from_str(x.trim()).ok())
        .unwrap_or(Value::Null)
}

/// The `territory` object of keeper A's status, wherever the status nests it.
fn territory_of(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            if let Some(t) = m.get("territory").filter(|t| t.get("landed").is_some()) {
                return t.clone();
            }
            m.values()
                .map(territory_of)
                .find(|x| !x.is_null())
                .unwrap_or(Value::Null)
        }
        Value::Array(a) => a
            .iter()
            .map(territory_of)
            .find(|x| !x.is_null())
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// The 0xDC territory ops (12 settle, 13 decay, 14 conquer) landed in the feed after `since`, by kind and payer.
fn territory_rows(r: &Run<'_>, since: u64, page_wallet: &Address) -> Value {
    let mut out = std::collections::BTreeMap::<String, (u64, u64, u64, u64)>::new();
    for l in r.lock().feed(0, usize::MAX, Some(&r.c.program)) {
        if l.slot <= since {
            continue;
        }
        let Ok(t) = fclient::tx::from_wire(&l.wire) else {
            continue;
        };
        let payer = t.message.account_keys.first().copied();
        for i in &t.message.instructions {
            if t.message.account_keys.get(i.program_id_index as usize) != Some(&r.c.program) {
                continue;
            }
            let name = match wix::WideCommand::decode(&i.data) {
                Ok(wix::WideCommand::TerritorySettle(_)) => "settle",
                Ok(wix::WideCommand::TerritoryDecay(_)) => "decay",
                Ok(wix::WideCommand::TerritoryConquer(_)) => "conquer",
                Ok(wix::WideCommand::ClaimTile(_)) => "claim",
                _ => continue,
            };
            let who = if payer.as_ref() == Some(page_wallet) {
                "page"
            } else {
                "keeper"
            };
            let e = out.entry(format!("{name}/{who}")).or_default();
            if l.err.is_none() {
                e.0 += 1;
                e.2 = e.2.max(l.units);
            } else {
                e.1 += 1;
            }
            e.3 = l.units.max(e.3);
        }
    }
    json!(out
        .into_iter()
        .map(|(k, (ok, bad, max_cu_ok, max_cu))| (
            k,
            json!({"landed": ok, "failed": bad, "max_cu_landed": max_cu_ok, "max_cu_any": max_cu})
        ))
        .collect::<serde_json::Map<_, _>>())
}

fn player_of(r: &Run<'_>, citizen: &Address) -> Option<TerritoryPlayer> {
    let ctx = r.ctx();
    r.data(&adr(wtr::player_address(&ctx, &citizen.to_bytes())))
        .and_then(|d| TerritoryPlayer::read(&d).ok())
}

fn province_of(r: &Run<'_>, c: WideCoord) -> Option<TerritoryProvince> {
    let ctx = r.ctx();
    r.data(&adr(wtr::province_address(&ctx, c)))
        .and_then(|d| TerritoryProvince::read(&d).ok())
}

/// A store's accrual record as the account holds it (value, rate, cap, t0, frac).
fn accrual_of(
    r: &Run<'_>,
    home: &Address,
    res: usize,
) -> permutation_rules::frontier::holding::Accrual {
    let d = r.data(home).unwrap();
    let o = H::store(res);
    permutation_rules::frontier::holding::Accrual {
        value: le_i64(&d, o + AC::VALUE),
        rate: le_i64(&d, o + AC::RATE),
        cap: le_i64(&d, o + AC::CAP),
        t0: le_i64(&d, o + AC::T0),
        frac: le_i64(&d, o + AC::FRAC),
    }
}

/// Tells the driver to go (`go-<step>`, with a JSON body) and waits for its `done-<step>.json`.
async fn driver_step(
    sync: &std::path::Path,
    alive: &mut dyn FnMut() -> bool,
    step: &str,
    body: Value,
    secs: u64,
) -> Value {
    std::fs::write(sync.join(format!("go-{step}")), body.to_string()).unwrap();
    let t0 = Instant::now();
    loop {
        if let Ok(t) = std::fs::read_to_string(sync.join(format!("done-{step}.json"))) {
            return serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        if let Ok(f) = std::fs::read_to_string(sync.join("failed.txt")) {
            panic!("the page driver failed at {step}: {f}");
        }
        assert!(alive(), "the page driver exited before {step}");
        assert!(
            t0.elapsed() < Duration::from_secs(secs),
            "the page driver did not finish {step} in {secs} s"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The page wallet's lamports spent by one landed transaction (its signature, base58).
fn wallet_spent(r: &Run<'_>, sig: &str) -> Option<(u64, u64, Option<String>)> {
    r.lock()
        .feed(0, usize::MAX, Some(&r.c.program))
        .into_iter()
        .find(|l| l.signature.to_string() == sig)
        .map(|l| {
            (
                l.pre_balances
                    .first()
                    .zip(l.post_balances.first())
                    .map_or(0, |(a, b)| a.saturating_sub(*b)),
                l.units,
                l.err.as_ref().map(|e| format!("{e:?}")),
            )
        })
}

/// A second participant of another nation than `not`: its Join and first home in an opened heartland province (REAL,
/// its own TEST key). → (its wallet key, Citizen, nation, home holding, (p, q, site)).
fn captor(r: &mut Run<'_>, not: u8) -> (Keypair, Address, u8, Address, (i32, i32, u8)) {
    let a = r.c.a.clone();
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let mut home = None;
    'find: for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let c = ProvinceCoord::new(pp, qq);
                if c.ring() as i32 != ring {
                    continue;
                }
                let Some(n) = home_nation(c, cq.placement, cq.heartland_max_ring, &gseed) else {
                    continue;
                };
                if n == not {
                    continue;
                }
                if let Some(d) = r.data(&a.province(pp, qq)) {
                    if let Some(site) = (0..d[PV::SITE_COUNT] as usize)
                        .find(|i| d[PV::site(*i) + SM::STATE] == SM::STATE_FREE)
                    {
                        home = Some((pp, qq, n, site as u8));
                        break 'find;
                    }
                }
            }
        }
    }
    let (hp, hq, n, site) = home.expect("a heartland province of another nation with a free site");
    let k = Keypair::new(); // TEST key
    let w = k.pubkey();
    r.lock().airdrop(&w, 2 * SOL).unwrap();
    let now = r.now();
    r.send(
        "the captor's Join",
        &[ix::join(&a, w, w, n, &w, now + 30 * 86_400, None)],
        &[&k],
        "a second participant (TEST key)",
    );
    let cd = r.data(&a.citizen(&w)).expect("the captor's Citizen");
    let (f, sh) = (cd[C::FACTION], cd[C::JOIN_SHARD]);
    assert_eq!(f, n);
    r.send(
        "the captor's PlaceHome",
        &[ix::place_home(
            &a,
            &ix::Player {
                actor: w,
                payer: w,
                wallet: w,
            },
            ix::Site {
                p: hp as i16,
                q: hq as i16,
                site,
            },
            f,
            sh,
        )],
        &[&k],
        "a second participant (TEST key)",
    );
    let h = a.holding(hp, hq, site);
    assert!(r.data(&h).is_some(), "the captor's first home");
    (k, a.citizen(&w), n, h, (hp, hq, site))
}

/// Declared: the keep of wide province `c` held by `nation`, a new keep generation, its recorded captor `home`.
fn declare_capture(
    r: &mut Run<'_>,
    c: WideCoord,
    nation: u8,
    home: (i32, i32, u8),
    home_gen: u8,
) -> u32 {
    let ctx = r.ctx();
    let k = adr(wl::province_address(&ctx, c));
    let mut acc = r.lock().account(&k).expect("the wide province");
    let mut keep = frontier_abi::conquest_model::read_keep(&acc.data)
        .expect("a keep record")
        .expect("a keep");
    keep.holder = nation;
    keep.gen = keep.gen.wrapping_add(1);
    keep.contender = keep.holder;
    keep.progress = 0;
    frontier_abi::conquest_model::write_keep(&mut acc.data, &keep).expect("write the keep");
    let cap = wl::KeepCaptor {
        home: WideCoord::checked(home.0 as i64, home.1 as i64).unwrap(),
        site: home.2,
        gen: home_gen,
        keep_gen: keep.gen,
    };
    assert!(wl::set_captor(&mut acc.data, &cap));
    r.patch(
        k,
        acc,
        &format!(
            "the keep of wide province ({}, {}) taken by nation {nation} from the home ({}, {}) site {} (keep gen {}; the captor record the wide Resolve writes on a real capture)",
            c.p(), c.q(), home.0, home.1, home.2, keep.gen
        ),
    );
    keep.gen
}

/// Declared: the first home cannot feed anything — its food 0 and its food upkeep the kernel's maximum.
fn declare_starved(r: &mut Run<'_>, home: Address) {
    let mut acc = r.lock().account(&home).expect("the first home");
    let now = r.now();
    let so = H::store(FOOD);
    let max = permutation_rules::frontier::holding::MAX_UPKEEP_PER_HOUR;
    acc.data[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&0i64.to_le_bytes());
    acc.data[so + AC::RATE..so + AC::RATE + 8].copy_from_slice(&(-max).to_le_bytes());
    acc.data[so + AC::T0..so + AC::T0 + 8].copy_from_slice(&now.to_le_bytes());
    acc.data[so + AC::FRAC..so + AC::FRAC + 8].copy_from_slice(&0i64.to_le_bytes());
    let u = H::UPKEEP + 8 * FOOD;
    acc.data[u..u + 8].copy_from_slice(&max.to_le_bytes());
    r.patch(
        home,
        acc,
        "the first home starved: food 0, food upkeep the kernel's maximum (an army its stores cannot feed)",
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn phase(
    r: &mut Run<'_>,
    ti: &Input,
    sync: &std::path::Path,
    alive: &mut dyn FnMut() -> bool,
    w: Address,
    home: Address,
    nation: u8,
    village: WideCoord,
    village_site: u8,
) -> Value {
    let a = r.c.a.clone();
    let citizen = a.citizen(&w);
    let genesis_ts = r.clock().3;
    let since0 = r.lock().slot();
    let run = |r: &Run<'_>| {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    };
    // the village on the page's own tile (the run so far)
    let p0 = player_of(r, &citizen).expect("the page's territory summary (its site tile)");
    let vp = province_of(r, village).expect("the wide village province's territory record");
    let vtile = {
        let d = r
            .data(&adr(wl::province_address(&r.ctx(), village)))
            .unwrap();
        d[PV::SITES + village_site as usize]
    };
    assert_eq!(
        vp.owner[vtile as usize], p0.citizen_tag,
        "the village stands on the page's own tile"
    );
    assert_eq!(p0.tiles, 1, "one tile so far: the village's");

    // 1. Two tiles from the card, a bell apart.
    let mut claims = vec![];
    for n in 1..=2u32 {
        run(r);
        let before = player_of(r, &citizen).unwrap();
        let ore_before = accrual_of(r, &home, ORE);
        let d = driver_step(
            sync,
            alive,
            &format!("tile-{n}"),
            json!({"row": n - 1, "en": n == 1}),
            300,
        )
        .await;
        let sig = d["signature"]
            .as_str()
            .unwrap_or_else(|| panic!("tile {n}: no signature: {d:#}"))
            .to_string();
        let target = WideCoord::checked(
            d["target"]["p"].as_str().unwrap().parse().unwrap(),
            d["target"]["q"].as_str().unwrap().parse().unwrap(),
        )
        .unwrap();
        let tile = d["tile"].as_u64().unwrap() as usize;
        r.run_until(1.0, 120, &format!("tile {n} on chain"), |r| {
            player_of(r, &citizen).is_some_and(|p| p.tiles == before.tiles + 1)
        })
        .await;
        let (spent, units, err) = wallet_spent(r, &sig).expect("the claim in the feed");
        assert!(err.is_none(), "tile {n}: {err:?}");
        let preview_total: u64 = d["preview"]["total"].as_str().unwrap().parse().unwrap();
        assert_eq!(
            spent, preview_total,
            "tile {n}: the wallet paid exactly the preview: {d:#}"
        );
        let ore_cost: i64 = d["preview"]["ore"].as_i64().unwrap();
        let ore_after = accrual_of(r, &home, ORE);
        // (the first home's ore: the preview's whole units × 1,000 milli; the store's own production since its last
        //  settle is added at the claim, so the drop is judged against the accrual at the claim's time; its rate is
        //  unchanged by a claim)
        assert_eq!(ore_after.rate, ore_before.rate, "tile {n}: the ore rate");
        let accrued = ore_before.value_at(ore_after.t0);
        assert_eq!(
            accrued - ore_after.value,
            ore_cost * 1_000,
            "tile {n}: the ore burned is the preview's (accrued {accrued}, after {})",
            ore_after.value
        );
        let tp = province_of(r, target).expect("the province's territory record");
        assert_eq!(tp.owner[tile], before.citizen_tag, "tile {n}: the page's");
        claims.push(json!({"n": n, "target": [target.p(), target.q()], "tile": tile, "signature": sig, "lamports": spent, "compute_units": units,
            "ore": ore_cost, "preview": d["preview"], "preview_text": d["text"], "preview_text_en": d["text_en"]}));
        // the next bell (one claim a turn)
        let b = r.bell();
        r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
    }
    let x1 = WideCoord::checked(
        claims[0]["target"][0].as_i64().unwrap(),
        claims[0]["target"][1].as_i64().unwrap(),
    )
    .unwrap();
    let t1 = claims[0]["tile"].as_u64().unwrap() as usize;

    // 2. keeper A's upkeep settles (every bell).
    let since = r.lock().slot();
    let paid0 = player_of(r, &citizen).unwrap().paid_to;
    for _ in 0..2 {
        let b = r.bell();
        r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
        r.run_until(
            2.0,
            180,
            "keeper A settles the page's upkeep this bell",
            |r| {
                player_of(r, &citizen)
                    .is_some_and(|p| p.paid_to >= genesis_ts + 600 * (b as i64 + 1))
            },
        )
        .await;
    }
    let p2 = player_of(r, &citizen).unwrap();
    assert!(
        p2.paid_to > paid0 && p2.unpaid_since.is_none(),
        "paid, by keeper A"
    );
    let settles = territory_rows(r, since, &w);
    assert!(
        settles["settle/keeper"]["landed"].as_u64().unwrap_or(0) >= 2,
        "{settles:#}"
    );
    assert_eq!(p2.tiles, 3);

    // 3. Declared captures by another nation; keeper A's conquest transfer.
    let (_ck, ccit, cnation, chold, chome) = captor(r, nation);
    let cgen = r.data(&chold).unwrap()[H::GEN];
    let g1 = declare_capture(r, x1, cnation, chome, cgen);
    let gv = declare_capture(r, village, cnation, chome, cgen);
    let since = r.lock().slot();
    let b = r.bell();
    r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
    r.run_until(
        2.0,
        240,
        "keeper A moves the page's tile of the captured province to the captor",
        |r| {
            province_of(r, x1).is_some_and(|tp| {
                player_of(r, &ccit).is_some_and(|c| tp.owner[t1] == c.citizen_tag)
            })
        },
    )
    .await;
    // (and a bell more: nothing is planned for the village's province — its only page tile carries the village)
    let b = r.bell();
    r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
    r.run_until(2.0, 60, "keeper A's next bell", |r| r.bell() > b)
        .await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let conquest = territory_rows(r, since, &w);
    assert_eq!(conquest["conquer/keeper"]["landed"], 1, "{conquest:#}");
    assert!(
        conquest
            .get("conquer/keeper")
            .and_then(|x| x["failed"].as_u64())
            .unwrap_or(0)
            == 0,
        "{conquest:#}"
    );
    let p3 = player_of(r, &citizen).unwrap();
    let cap = player_of(r, &ccit).expect("the captor's summary (created by the conquest)");
    let vp3 = province_of(r, village).unwrap();
    assert_eq!(p3.tiles, 2, "the captured province's tile moved");
    assert_eq!(cap.tiles, 1);
    assert_eq!(
        vp3.owner[vtile as usize], p3.citizen_tag,
        "the village's tile stays with its village"
    );

    // 4. Declared starvation → unpaid → the page's claim refused → decay after 24 bells, farthest first.
    declare_starved(r, home);
    let b = r.bell();
    r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
    r.run_until(
        2.0,
        180,
        "keeper A's settle finds the page's upkeep unpaid",
        |r| player_of(r, &citizen).is_some_and(|p| p.unpaid_since.is_some()),
    )
    .await;
    let unpaid_since = player_of(r, &citizen).unwrap().unpaid_since.unwrap();
    run(r);
    let refusal = driver_step(sync, alive, "refusal", json!({"row": 0}), 300).await;
    assert_eq!(refusal["ja"]["code"], "TileUnpaid", "{refusal:#}");
    assert_eq!(refusal["en"]["code"], "TileUnpaid", "{refusal:#}");
    assert_eq!(
        refusal["sent"], false,
        "nothing signed or sent: {refusal:#}"
    );
    let before = player_of(r, &citizen).unwrap();
    // the farthest of the two remaining tiles goes first
    let tp_x2 = {
        let x2 = WideCoord::checked(
            claims[1]["target"][0].as_i64().unwrap(),
            claims[1]["target"][1].as_i64().unwrap(),
        )
        .unwrap();
        (x2, claims[1]["tile"].as_u64().unwrap() as usize)
    };
    let d_x2 = province_of(r, tp_x2.0).unwrap().dist[tp_x2.1];
    let d_v = vp3.dist[vtile as usize];
    let since = r.lock().slot();
    let grace = 24u32;
    r.advance_exact(genesis_ts + 600 * ((unpaid_since + grace) as i64) + 30);
    r.run_until(2.0, 240, "keeper A's first decay", |r| {
        player_of(r, &citizen).is_some_and(|p| p.tiles == before.tiles - 1)
    })
    .await;
    let first_gone = if d_x2 >= d_v {
        province_of(r, tp_x2.0).unwrap().owner[tp_x2.1] == 0
    } else {
        province_of(r, village).unwrap().owner[vtile as usize] == 0
    };
    assert!(
        first_gone,
        "the farthest tile first (dist x2 {d_x2}, village tile {d_v})"
    );
    let b = r.bell();
    r.advance_exact(genesis_ts + 600 * (b as i64 + 1) + 30);
    r.run_until(2.0, 240, "keeper A's second decay, a bell later", |r| {
        player_of(r, &citizen).is_some_and(|p| p.tiles == 0)
    })
    .await;
    let decay = territory_rows(r, since, &w);
    assert_eq!(decay["decay/keeper"]["landed"], 2, "{decay:#}");
    let pend = player_of(r, &citizen).unwrap();
    assert_eq!(
        pend.released,
        before.released + 2,
        "two tiles released by decay"
    );
    // keeper A's own word
    run(r);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let status = territory_of(&keeper_status(ti.keeper_api, &ti.token));
    std::fs::write(sync.join("go-end"), "end").unwrap();
    let all = territory_rows(r, since0, &w);
    json!({
        "p18": "player territory on the new devnet .so: the page's tiles (preview = paid), keeper A's settle / conquest / decay",
        "village": {"p": village.p(), "q": village.q(), "site": village_site, "tile": vtile},
        "claims": claims,
        "settles": settles,
        "captor": {"citizen": ccit.to_string(), "nation": cnation, "home": [chome.0, chome.1, chome.2], "keep_gens": [g1, gv]},
        "conquest": conquest, "after_conquest": {"page_tiles": p3.tiles, "captor_tiles": cap.tiles},
        "unpaid_since_bell": unpaid_since, "page_refusal": refusal,
        "decay": decay, "dist": {"second_tile": d_x2, "village_tile": d_v},
        "territory_ops_by_kind": all, "keeper_status_territory": status,
    })
}
