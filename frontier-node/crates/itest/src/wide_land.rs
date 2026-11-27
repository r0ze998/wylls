//! **TEST-ONLY wide land** on a natural local world (runner `--wide-land local-wide-land-v1`, launcher option of the
//! same words, `scripts/play-local.sh --wide`). The owner asked to see the wide version; on the plain natural world the
//! map ends at ring 16 (`S1_LOCAL_7D`, `r_max_ceiling` 0) and the wide land (rings 129+) can never open.
//!
//! What it does, in the world's setup, while the chain's clock is still SYNTHETIC (before `ready-for-join`):
//!
//! 1. the Season is created from **`S1_DEVNET_WIDE_7D`** (the devnet playable preset of #70: `S1_LOCAL_7D`, centre-free
//!    placement 2, `r_max_ceiling` 128, θ 1 bp, a 36 SOL province fund) instead of `S1_LOCAL_7D`;
//! 2. ONE heartland province is opened and one **test participant** (its own in-memory key, funded by the test chain's
//!    faucet) Joins and places a home there, so "some wedge has a settler" (θ 1 bp) holds by the program's own fold;
//! 3. the map grows by the program's own instructions, **one ring per bell** (the program's rule; the TEST clock is
//!    moved one bell at a time, as `advance_to` moves it before genesis): ExtendFrontier past `r_max` 16, OpenRing
//!    4..=128, then each ring's ConsumeRingSeed with its own round (public drand Quicknet, BLS-verified by the
//!    program). No legacy province is opened beyond the heartland (the devnet keeper's `lazy_provinces`);
//! 4. the wide land: WideRequestRingSeed(129), WideConsumeRingSeed(129) (its own verified round), WideSetRules (the
//!    Season authority, i.e. this world's own in-memory upgrade key: the playable conquest world's rule bytes), then
//!    WideOpenProvince for [`PER_WEDGE`] provinces in the middle of each wedge, and the same for the next
//!    [`WIDE_RINGS`]` - 1` wide rings, a bell apart; on ring 128 the ordinary OpenProvince of every rim province that
//!    borders a ring-129 province opened here ([`rim_plan`]), so the legacy edge and the wide land meet.
//!
//! 5. the rest of the heartland is opened only now, one test participant per other nation places a home there, and
//!    EVERY opened province — the first, the rim opened at the growth's end, the heartland — is brought up to now by
//!    the keeper's own PostAnchor / FastForward ([`catch_up_all`]; before fix wide-herald-lag only the first was, and
//!    the rim started ~12 turns behind).
//!
//! From `ready-for-join` until the player's home lands, [`warm_keep`] keeps every province current (the keeper loop
//! starts only on that home).
//!
//! Every step is the program's own instruction; no account is written directly; no rule, parameter or program byte
//! changes beyond choosing the existing devnet preset for this local season. The clock after `ready-for-join` is the
//! natural world's (1x). Every line it prints says `test_only: true`.
use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::{ix, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::presets::{SeasonParamsV2, S1_DEVNET_WIDE_7D};
use frontier_abi::world_index::land::{self as wl, WideRingSeed, FIRST_WIDE_RING};
use frontier_abi::world_index::rules as wr;
use frontier_abi::world_index::WideCoord;
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};
use serde_json::{json, Value};

use crate::expedition_play::{PROGRAM, PROGRAM_VERSION};

pub const WIDE_LAND_MODE: &str = "local-wide-land-v1";
pub const WIDE_SCHEMA: &str = "frontier-localnet-wide-land-v1";
/// The wide rings opened: 129, 130, 131.
pub const WIDE_RINGS: u64 = 3;
/// The wide rings whose seed the setup consumes (expansion-gameplay-1): 129..=136. Rings past [`WIDE_RINGS`] open no
/// province in the setup; `wide_frontier` opens their provinces later, next to land a nation went to.
pub const WIDE_SEED_RINGS: u64 = 8;
/// Wide provinces opened per wedge on each wide ring (paid from that wedge's fund).
pub const PER_WEDGE: usize = 6;
/// Rounds fetched at once from the public drand API.
const FETCH_AT_ONCE: usize = 16;
const SETTLER_LAMPORTS: u64 = 5_000_000_000;

/// `--wide-land local-wide-land-v1` out of the runner's arguments (at most once, exactly that word).
pub fn take_wide_args(mut args: Vec<String>) -> Result<(Vec<String>, bool), String> {
    let Some(i) = args.iter().position(|a| a == "--wide-land") else {
        return Ok((args, false));
    };
    let v = args
        .get(i + 1)
        .cloned()
        .ok_or("--wide-land needs a value")?;
    args.drain(i..i + 2);
    if args.iter().any(|a| a == "--wide-land") {
        return Err("--wide-land given twice".into());
    }
    if v != WIDE_LAND_MODE {
        return Err(format!("--wide-land takes exactly `{WIDE_LAND_MODE}`"));
    }
    Ok((args, true))
}

/// `--wide-scale <1-60>` out of the runner's arguments (TEST-ONLY, wide world only, at most once): the chain clock's
/// scale from `ready-for-join` on (game seconds per real second), so a rim Hamlet's stores reach the settler cost of a
/// wide claim within a play session (1× takes ~30 h of game time; ×60 ~30 min). `None` without it (1×).
pub fn take_wide_scale(mut args: Vec<String>) -> Result<(Vec<String>, Option<u32>), String> {
    let Some(i) = args.iter().position(|a| a == "--wide-scale") else {
        return Ok((args, None));
    };
    let v = args
        .get(i + 1)
        .cloned()
        .ok_or("--wide-scale needs a value")?;
    args.drain(i..i + 2);
    if args.iter().any(|a| a == "--wide-scale") {
        return Err("--wide-scale given twice".into());
    }
    let n: u32 = v
        .parse()
        .ok()
        .filter(|n: &u32| (1..=60).contains(n) && v == n.to_string())
        .ok_or("--wide-scale takes a whole number 1-60")?;
    Ok((args, Some(n)))
}

/// The wide world's Season: the real `S1_DEVNET_WIDE_7D` with the deployed program's version.
pub fn params() -> SeasonParamsV2 {
    // (TEST-ONLY local rules on top: the centre free and a Hamlet rim home anchors a wide claim; `wide_play`)
    let mut p = crate::wide_play::local_wide(S1_DEVNET_WIDE_7D);
    p.base.program_version = PROGRAM_VERSION;
    p
}

/// [`params`] with the NEXT world's pacing bytes (TEST-ONLY `--pacing fast-v1`, world4-pacing-impl):
/// `frontier_abi::v2::presets::pacing_fast` on top of the local wide rules — the bytes world 4's preset
/// `S1_DEVNET_TERRITORY_FAST` adds to world 3's.
pub fn params_paced() -> SeasonParamsV2 {
    frontier_abi::v2::presets::pacing_fast(params())
}

/// `--pacing fast-v1` out of the runner's arguments (TEST-ONLY, at most once; exactly that word): whether the wide
/// world takes [`params_paced`].
pub fn take_pacing_args(mut args: Vec<String>) -> Result<(Vec<String>, bool), String> {
    let Some(i) = args.iter().position(|a| a == "--pacing") else {
        return Ok((args, false));
    };
    let v = args.get(i + 1).cloned().ok_or("--pacing needs a value")?;
    args.drain(i..i + 2);
    if args.iter().any(|a| a == "--pacing") {
        return Err("--pacing given twice".into());
    }
    if v != PACING_MODE {
        return Err(format!("--pacing takes exactly `{PACING_MODE}`"));
    }
    Ok((args, true))
}

/// The word of [`take_pacing_args`].
pub const PACING_MODE: &str = "fast-v1";

/// The wide provinces opened on `ring`: per wedge, the `per_wedge` provinces in the middle of that wedge's arc (in
/// the ring's walking order), wedges in order. Pure.
pub fn wide_plan(ring: u64, per_wedge: usize) -> Vec<WideCoord> {
    // (one copy: the keeper's P6 duty opens the same plan on devnet)
    keeper_core::widelane::wide_plan(ring, per_wedge)
}

/// The rim provinces opened beside the wide land: every ring-128 province that borders one of `plan`'s ring-129
/// provinces, in plan order, each once. Pure.
pub fn rim_plan(plan: &[WideCoord]) -> Vec<(i32, i32)> {
    let mut out = vec![];
    for c in plan.iter().filter(|c| c.ring() == FIRST_WIDE_RING) {
        for (dp, dq) in [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)] {
            let n = (c.p() as i32 + dp, c.q() as i32 + dq);
            if ProvinceCoord::new(n.0, n.1).ring() == u32::from(R_MAX_HARD) && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// The statement on the runner's first line.
pub fn wide_metadata(meta: &mut Value, summary: &Value) {
    if let Some(m) = meta.as_object_mut() {
        m.insert(
            "wide_land".into(),
            json!({"mode": WIDE_LAND_MODE, "preset": "S1_DEVNET_WIDE_7D", "test_only": true, "summary": summary}),
        );
        m.insert("clock".into(), json!("SYNTHETIC before genesis and through the wide land's growth (one ring per bell, TEST-ONLY local-wide-land-v1); NATURAL from ready-for-join on, never moved again"));
    }
}

fn step(s: &str, extra: Value) {
    let mut v = json!({"schema": WIDE_SCHEMA, "wide_step": s, "test_only": true});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    eprintln!("{v}");
}

fn ctx(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: PROGRAM,
        season: a.season.to_bytes(),
    }
}
fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}

/// 0xD6 WideRequestRingSeed: `[payer s,w] [season r] [frontier r] [previous ring seed r] [wide ring seed w]
/// [pfund × 6 r] [system]`.
pub fn request_ix(a: &Addresses, payer: Address, ring: u64) -> Instruction {
    keeper_core::widelane::request_ring_seed(a, payer, ring)
}

/// 0xD7 WideConsumeRingSeed: `[payer s,w] [season r] [wide ring seed w]`.
pub fn consume_ix(
    a: &Addresses,
    payer: Address,
    ring: u64,
    round: u64,
    sig48: [u8; 48],
) -> Result<Instruction, String> {
    keeper_core::widelane::consume_ring_seed(a, payer, ring, round, sig48)
}

/// 0xD8 WideOpenProvince: `[payer s,w] [season r] [wide ring seed w] [pfund w] [province w] [rules_config r] [system]`.
pub fn open_ix(a: &Addresses, payer: Address, coord: WideCoord) -> Result<Instruction, String> {
    keeper_core::widelane::open_province(a, payer, coord)
}

/// Fetches and verifies `rounds` from the public drand API, at most [`FETCH_AT_ONCE`] at a time.
async fn fetch_all(rounds: &[u64]) -> Result<BTreeMap<u64, [u8; 48]>, String> {
    let mut out = BTreeMap::new();
    for chunk in rounds.chunks(FETCH_AT_ONCE) {
        let mut set = tokio::task::JoinSet::new();
        for &r in chunk {
            set.spawn(async move { (r, crate::local_keeper::fetch_round_at(r).await) });
        }
        while let Some(j) = set.join_next().await {
            let (r, sig) = j.map_err(|e| format!("drand fetch task: {e}"))?;
            out.insert(r, sig?);
        }
    }
    Ok(out)
}

fn read(state: &Shared, k: &Address, what: &str) -> Result<Vec<u8>, String> {
    lock(state)
        .account(k)
        .map(|x| x.data)
        .ok_or_else(|| format!("{what} is not there"))
}
fn frontier_u16(state: &Shared, a: &Addresses, off: usize) -> Result<u16, String> {
    let d = read(state, &a.frontier(), "the Frontier")?;
    Ok(u16::from_le_bytes(
        d.get(off..off + 2)
            .ok_or("the Frontier")?
            .try_into()
            .unwrap(),
    ))
}
fn frontier_u32(state: &Shared, a: &Addresses, off: usize) -> Result<u32, String> {
    let d = read(state, &a.frontier(), "the Frontier")?;
    Ok(u32::from_le_bytes(
        d.get(off..off + 4)
            .ok_or("the Frontier")?
            .try_into()
            .unwrap(),
    ))
}

/// The world's setup step (module doc, steps 2–4), on the prepared chain before `ready-for-join`. `send` lands one
/// transaction (the natural world's own, synchronous); `advance_to` moves the SYNTHETIC clock. Returns the summary
/// stated on the runner's first line.
pub async fn grow(
    state: &Shared,
    a: &Addresses,
    authority: &Keypair,
    payer: &Keypair,
    homes: &[(i16, i16, u8)],
    send: impl Fn(&Shared, &[&Keypair], &[Instruction], &str) -> Result<String, String>,
    advance_to: impl Fn(&Shared, i64) -> Result<(), String>,
) -> Result<(Value, Vec<(i16, i16, u8)>), String> {
    let t0 = std::time::Instant::now();
    let season_clock = || -> Result<fclient::clock::SeasonClock, String> {
        let c = lock(state);
        crate::local_keeper::season_clock(&c, a)
    };
    let clock = season_clock()?;
    let bell_start = |b: u32| clock.genesis_ts + b as i64 * fclient::abi::BELL_SECS;
    let now = || lock(state).unix_timestamp();
    // (the Season's stored authority must be this world's own upgrade key: WideSetRules is signed by it)
    let sd = read(state, &a.season, "the Season")?;
    let stored: [u8; 32] = sd[frontier_abi::v2::layout::world::season::AUTHORITY..][..32]
        .try_into()
        .unwrap();
    if stored != authority.pubkey().to_bytes() {
        return Err("the Season's authority is not this world's own key".into());
    }
    // 2. the first heartland province and one test participant in it (θ 1 bp: some wedge has a settler); the rest of
    //    the heartland is opened after the growth, so its provinces start resolved to the turn the player joins at
    let first = *homes.first().ok_or("no heartland province")?;
    send(
        state,
        &[payer],
        &[ix::open_province(a, payer.pubkey(), first.0, first.1)],
        "OpenProvince",
    )?;
    let mut settlers = vec![];
    settle(state, a, first, &send, &now, &mut settlers)?;
    for part in 0..3u8 {
        send(
            state,
            &[payer],
            &[ix::fold_occupancy(a, payer.pubkey(), part)],
            "FoldOccupancy",
        )?;
    }
    step("settled", json!({"test_participants": settlers.len()}));
    // 3. the legacy rings, one per bell, to the rim
    let r_max = params().base.r_max;
    let first_ring = frontier_u16(state, a, FR::RINGS_OPENED)?;
    let mut pending: Vec<(u16, u64)> = vec![];
    for d in first_ring..=R_MAX_HARD {
        let last = frontier_u32(state, a, FR::LAST_RING_OPEN_BELL)?;
        advance_to(state, bell_start(last + 1) + 1)?;
        if d > r_max {
            send(
                state,
                &[payer],
                &[ix::v2::extend_frontier(a, payer.pubkey(), d)],
                &format!("ExtendFrontier({d})"),
            )?;
        }
        send(
            state,
            &[payer],
            &[ix::open_ring(a, payer.pubkey(), d)],
            &format!("OpenRing({d})"),
        )?;
        let rs = fclient::decode::RingSeed::decode(&read(state, &a.ring_seed(d), "the RingSeed")?)
            .map_err(|e| format!("RingSeed {d}: {e:?}"))?;
        if rs.status != RS::STATUS_REQUESTED {
            return Err(format!("RingSeed {d} is in status {}", rs.status));
        }
        pending.push((d, rs.round));
        if d % 16 == 0 {
            step("rings", json!({"opened_through": d}));
        }
    }
    let rounds: Vec<u64> = pending.iter().map(|x| x.1).collect();
    let sigs = fetch_all(&rounds).await?;
    let last_round = rounds.iter().copied().max().unwrap_or(0);
    advance_to(state, clock.drand.round_time(last_round) + 1)?;
    for &(d, round) in &pending {
        let arg = ix::BeaconArg {
            round,
            sig48: sigs[&round],
            hints: fclient::beacon::hints_bytes(round),
        };
        send(
            state,
            &[payer],
            &[ix::consume_ring_seed(a, payer.pubkey(), d, &arg)],
            &format!("ConsumeRingSeed({d})"),
        )?;
    }
    step(
        "rim",
        json!({"rings_opened": frontier_u16(state, a, FR::RINGS_OPENED)?, "r_max_ext": frontier_u16(state, a, FR::R_MAX_EXT)?}),
    );
    // 4. the wide land
    let c = ctx(a);
    let mut wide = vec![];
    let mut rim = vec![];
    let mut opened_bell = frontier_u32(state, a, FR::LAST_RING_OPEN_BELL)?;
    for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + WIDE_SEED_RINGS {
        advance_to(state, bell_start(opened_bell + 1) + 1)?;
        send(
            state,
            &[payer],
            &[request_ix(a, payer.pubkey(), ring)],
            &format!("WideRequestRingSeed({ring})"),
        )?;
        let k = addr(wl::ring_seed_address(&c, ring));
        let rec = WideRingSeed::read(&read(state, &k, "the wide ring seed")?)
            .map_err(|e| format!("wide ring seed {ring}: {e:?}"))?;
        opened_bell = clock
            .bell_at(now())
            .ok_or("the clock is before the Season")?;
        let sig = fetch_all(&[rec.round]).await?;
        advance_to(state, clock.drand.round_time(rec.round) + 1)?;
        send(
            state,
            &[payer],
            &[consume_ix(
                a,
                payer.pubkey(),
                ring,
                rec.round,
                sig[&rec.round],
            )?],
            &format!("WideConsumeRingSeed({ring})"),
        )?;
        if ring == FIRST_WIDE_RING {
            // (the playable conquest world's rule bytes, as the devnet preset's test: the deployed Free City site, no
            //  camp, the sort-key-hash region — and, owner decision Q-1 2026-11-24 (expansion-gameplay-1), every wide
            //  keep opens UNOWNED (the neutral side), not interleaved by nation: nations take wide land themselves;
            //  territory-impl, owner 2026-11-24 12:09: the new-world bundle — those keeps weaker (E-Q1) and player
            //  territory V1 (single-tile claims, food upkeep, villages on one's own tiles))
            let rules = wr::RuleBytes {
                keep_holder: wr::KeepHolderRule::NeutralTerritoryV1 as u8,
                free_city: wr::FreeCityRule::DeployedLe32V1 as u8,
                camp: wr::CampRule::NoCamp as u8,
                region: wr::RegionRule::SortKeyHashV1 as u8,
            };
            send(
                state,
                &[authority],
                &[crate::wide_destination::set_rules_ix_with(
                    &a.season,
                    &authority.pubkey(),
                    &rules,
                )],
                "WideSetRules",
            )?;
        }
        // (rings past WIDE_RINGS: the seed only; `wide_frontier` opens their provinces where a nation goes)
        let plan = if ring < FIRST_WIDE_RING + WIDE_RINGS {
            wide_plan(ring, PER_WEDGE)
        } else {
            vec![]
        };
        for coord in &plan {
            send(
                state,
                &[payer],
                &[open_ix(a, payer.pubkey(), *coord)?],
                &format!("WideOpenProvince({}, {})", coord.p(), coord.q()),
            )?;
        }
        if ring == FIRST_WIDE_RING {
            // (the legacy rim beside each wide arc: the ordinary OpenProvince on the seeded ring 128)
            for (p, q) in rim_plan(&plan) {
                send(
                    state,
                    &[payer],
                    &[ix::open_province(a, payer.pubkey(), p as i16, q as i16)],
                    &format!("OpenProvince({p}, {q})"),
                )?;
                rim.push(json!({"p": p, "q": q}));
            }
        }
        step(
            "wide_ring",
            json!({"ring": ring, "round": rec.round, "provinces": plan.len()}),
        );
        wide.push(json!({"ring": ring, "provinces": plan.iter().map(|c| json!({"p": c.p().to_string(), "q": c.q().to_string()})).collect::<Vec<_>>()}));
    }
    // 4b. (TEST-ONLY wide play) one real rim first home per nation and rim province (`wide_play::settle_rim`)
    let sd = read(state, &a.season, "the Season")?;
    let cq = frontier_abi::v2::presets::ConquestParams::of_season(&sd)
        .ok_or("the Season's conquest params")?;
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let rim_xy: Vec<(i32, i32)> = rim
        .iter()
        .filter_map(|v| Some((v["p"].as_i64()? as i32, v["q"].as_i64()? as i32)))
        .collect();
    let rim_homes = crate::wide_play::rim_homes(&rim_xy, &cq, &seed);
    let rim_settlers =
        crate::wide_play::settle_rim(state, a, payer, &rim_homes, &send, &advance_to).await?;
    // 5. the rest of the heartland, the other nations' test participants, and the first province brought up to now
    for &(p, q, _) in homes.iter().skip(1) {
        send(
            state,
            &[payer],
            &[ix::open_province(a, payer.pubkey(), p, q)],
            "OpenProvince",
        )?;
    }
    for nation in (0..fclient::abi::FACTIONS).filter(|n| *n != first.2) {
        let Some(&at) = homes
            .iter()
            .skip(1)
            .find(|h| h.2 == nation && free_site(state, a, h.0, h.1).is_some())
        else {
            return Err(format!("no free heartland site for nation {nation}"));
        };
        settle(state, a, at, &send, &now, &mut settlers)?;
    }
    // (fix wide-herald-lag: EVERY opened province, not only the first — the rim's 42 were opened at bell ~127 and were
    //  left ~12 turns behind the bell the player joins at, then a FastForward of 16 turns per keeper visit, round-robin
    //  over all of them, took ~60 turns (~10 min at ×60) to bring them up: every muster/departure there waited)
    let all: Vec<(i16, i16)> = {
        let c = lock(state);
        crate::legacy_march::opened_provinces(&c, a)
            .into_iter()
            .map(|(p, q)| (p as i16, q as i16))
            .collect()
    };
    let every = catch_up_all(state, a, payer, &all, &send, &advance_to).await?;
    let caught_up = {
        let c = lock(state);
        crate::local_keeper::view(&c, a, first.0, first.1)?.resolved_next
    };
    step(
        "caught_up",
        json!({"province": [first.0, first.1], "resolved_next": caught_up, "every": every}),
    );
    let summary = json!({
        "test_participants": settlers,
        "first_province_resolved_next": caught_up,
        "caught_up": every,
        "legacy_rings_opened": frontier_u16(state, a, FR::RINGS_OPENED)?,
        "r_max_ext": frontier_u16(state, a, FR::R_MAX_EXT)?,
        "rim_provinces": rim,
        "rim_settlers": rim_settlers,
        "wide_rings": wide,
        "bell_at_ready": clock.bell_at(now()),
        "setup_secs": t0.elapsed().as_secs(),
    });
    step("done", summary.clone());
    Ok((summary, rim_homes))
}

/// One test participant (its own in-memory key, funded by the test chain's faucet): Join, then PlaceHome on the first
/// free site of `at` (a heartland province of its nation).
fn settle(
    state: &Shared,
    a: &Addresses,
    at: (i16, i16, u8),
    send: &impl Fn(&Shared, &[&Keypair], &[Instruction], &str) -> Result<String, String>,
    now: &impl Fn() -> i64,
    out: &mut Vec<Value>,
) -> Result<(), String> {
    let (p, q, nation) = at;
    let k = Keypair::new();
    let w = k.pubkey();
    {
        let mut c = lock(state);
        c.airdrop(&w, SETTLER_LAMPORTS)?;
        c.produce_block();
    }
    send(
        state,
        &[&k],
        &[ix::join(a, w, w, nation, &w, now() + 3_600, None)],
        "test participant Join",
    )?;
    let (f, sh) = crate::natural_play::joined(
        &read(state, &a.citizen(&w), "the test participant's Citizen")?,
        &w,
    )
    .ok_or("the test participant did not join")?;
    let site = free_site(state, a, p, q).ok_or("no free site")?;
    send(
        state,
        &[&k],
        &[ix::place_home(
            a,
            &ix::Player {
                actor: w,
                payer: w,
                wallet: w,
            },
            ix::Site { p, q, site },
            f,
            sh,
        )],
        "test participant PlaceHome",
    )?;
    out.push(json!({"nation": nation, "p": p, "q": q, "site": site}));
    Ok(())
}

/// The province opened before the growth is ~129 turns behind once the map is grown, and the rim's provinces (opened
/// at the growth's end) a dozen or more; the local keeper anchors at most 16 turns ahead of a province per reveal
/// window and visits the world's provinces round-robin, so it would take ~10 min at ×60 (over an hour at 1×) to catch
/// up. Here, still on the synthetic setup clock, the keeper's own steps bring EVERY opened province up to now (fix
/// wide-herald-lag; before, only the first): per pass,
/// every region's missing anchors from its least `resolved_next` to now (one PostAnchor each; the rounds fetched once
/// and verified by the program), the clock moved once past the last reveal window, then each province FastForwarded
/// as far as its closed windows prove — 16 turns per transaction, only when the simulation accepts (a province that is
/// not quiet is left to the keepers, as before; nothing is forced). Returns `{provinces, resident, behind, least,
/// anchors, fast_forwards, passes}`: `resident` counts the provinces a muster may start from at the bell the player
/// joins at (`resident_ok`).
async fn catch_up_all(
    state: &Shared,
    a: &Addresses,
    payer: &Keypair,
    provinces: &[(i16, i16)],
    send: &impl Fn(&Shared, &[&Keypair], &[Instruction], &str) -> Result<String, String>,
    advance_to: &impl Fn(&Shared, i64) -> Result<(), String>,
) -> Result<Value, String> {
    use crate::local_keeper as lk;
    let clock = {
        let c = lock(state);
        lk::season_clock(&c, a)?
    };
    let views = || -> Result<Vec<lk::HomeView>, String> {
        let c = lock(state);
        provinces
            .iter()
            .map(|&(p, q)| lk::view(&c, a, p, q))
            .collect()
    };
    let behind = |vs: &[lk::HomeView]| {
        vs.iter()
            .filter(|v| !frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now))
            .count()
    };
    let mut sigs: BTreeMap<u64, [u8; 48]> = BTreeMap::new();
    let (mut anchors, mut ffs, mut passes) = (0u32, 0u32, 0u32);
    for _pass in 0..4 {
        let vs = views()?;
        if behind(&vs) == 0 {
            break;
        }
        passes += 1;
        let now_bell = vs.iter().map(|v| v.bell_now).max().unwrap_or(0);
        // (from a turn's start, so the windows close before the turn after next begins)
        advance_to(
            state,
            clock.genesis_ts + now_bell as i64 * fclient::abi::BELL_SECS + 1,
        )?;
        let vs = views()?;
        let from = region_spans(&vs);
        let posts: Vec<(u8, u32)> = {
            let c = lock(state);
            anchor_plan(&vs, |rg, r| lk::missing_anchors(&c, a, rg, r))
                .into_iter()
                .flat_map(|(b, rgs)| rgs.into_iter().map(move |rg| (rg, b)))
                .collect()
        };
        let want: Vec<u64> = {
            let mut w: Vec<u64> = posts
                .iter()
                .map(|(_, b)| clock.tlock_round(*b))
                .filter(|r| !sigs.contains_key(r))
                .collect();
            w.sort_unstable();
            w.dedup();
            w
        };
        if !want.is_empty() {
            sigs.extend(fetch_all(&want).await?);
        }
        for &(rg, b) in &posts {
            let round = clock.tlock_round(b);
            let r = lk::RoundProvenance {
                bell: b,
                round,
                signature_hex: hex::encode(sigs[&round]),
                source: format!("{}/public/{round}", lk::DRAND_URL),
                verified_against:
                    "fclient::beacon::quicknet_info().public_key (pinned Quicknet key)",
            };
            send(
                state,
                &[payer],
                &[lk::post_anchor_ix(a, &payer.pubkey(), rg, &r)?],
                &format!("PostAnchor(bell {b}, region {rg})"),
            )?;
            anchors += 1;
        }
        let mut close = 0i64;
        {
            let c = lock(state);
            for (rg, (lo, hi)) in &from {
                for b in *lo..*hi {
                    if let Some(t) = lk::anchor_landed(&c, a, b, *rg)? {
                        close = close.max(clock.reveal_close(b, t));
                    }
                }
            }
        }
        advance_to(state, close + 1)?;
        for &(p, q) in provinces {
            loop {
                let (v, to) = {
                    let c = lock(state);
                    let v = lk::view(&c, a, p, q)?;
                    let limit = v
                        .bell_now
                        .min(v.resolved_next.saturating_add(lk::MAX_FAST_FORWARD_BELLS));
                    let to = lk::closed_through(&c, a, v.region, v.resolved_next, limit)?;
                    (v, to)
                };
                if to <= v.resolved_next {
                    break;
                }
                let ix = lk::fast_forward_ix(a, &payer.pubkey(), p, q, &v, to)?;
                let ok = {
                    let c = lock(state);
                    lk::simulate_ix(&c, payer, &ix).is_ok_and(|x| x.err.is_none())
                };
                if !ok {
                    // (not quiet, or refused: the keepers resolve it for real, as before)
                    break;
                }
                send(
                    state,
                    &[payer],
                    &[ix],
                    &format!("FastForward({p}, {q} to {to})"),
                )?;
                ffs += 1;
            }
        }
    }
    let vs = views()?;
    Ok(json!({
        "provinces": vs.len(),
        "resident": vs.len() - behind(&vs),
        "behind": behind(&vs),
        "least": vs.iter().map(|v| v.resolved_next).min(),
        "bell": vs.iter().map(|v| v.bell_now).max(),
        "anchors": anchors,
        "fast_forwards": ffs,
        "passes": passes,
    }))
}

/// Per region of `views`, the turns its provinces still need: from the least `resolved_next` to the latest `bell_now`.
pub fn region_spans(views: &[crate::local_keeper::HomeView]) -> BTreeMap<u8, (u32, u32)> {
    let mut from: BTreeMap<u8, (u32, u32)> = BTreeMap::new();
    for v in views {
        let e = from
            .entry(v.region)
            .or_insert((v.resolved_next, v.bell_now));
        e.0 = e.0.min(v.resolved_next);
        e.1 = e.1.max(v.bell_now);
    }
    from
}

/// The anchors to post (pure): for each ended turn, the regions whose provinces still need it and whose anchor
/// `missing(region, turns)` says is absent — by turn, ascending, so one PostAnchorMulti serves every region of a turn.
pub fn anchor_plan(
    views: &[crate::local_keeper::HomeView],
    missing: impl Fn(u8, std::ops::Range<u32>) -> Vec<u32>,
) -> BTreeMap<u32, Vec<u8>> {
    let mut by_bell: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    for (rg, (lo, hi)) in region_spans(views) {
        for b in missing(rg, lo..hi) {
            by_bell.entry(b).or_default().push(rg);
        }
    }
    by_bell
}

/// How often the warm keeper looks again when it has nothing to send.
pub const WARM_TICK: std::time::Duration = std::time::Duration::from_millis(1_000);
/// The warm keeper's bells anchored per pass (bounded network use: one drand round per bell).
pub const WARM_BELLS_PER_PASS: usize = 8;

/// **TEST-ONLY wide world (fix wide-herald-lag): the world kept current before the player's home lands.** The keeper
/// loop starts only on the player's home (its first village); until then — the page loading, Join, PlaceHome or a rim
/// ticket's settling, a minute or more of a ×60 clock — no one anchors a turn or moves a province, so every province
/// (and the herald's completeness, and every operator AI village's muster) fell behind by every turn the player took to
/// join. This duty does the keeper's world phase over EVERY opened legacy province meanwhile: each ended turn's missing
/// anchors, every region at once (PostAnchorMulti, its round from the public drand API, verified by the program), then
/// each province FastForwarded as far as its closed windows prove (≤ 16 turns per transaction, only when the
/// simulation accepts: a not-quiet province is left to the keeper loop, as before). It stops for good when `until`
/// turns true (the binary sets it once the player's home has landed and waits for this task to end before the keeper
/// loop starts, so the two never race on one anchor). Program instructions only; no rule or account is touched.
pub async fn warm_keep(
    state: Shared,
    a: Addresses,
    mut stop: tokio::sync::watch::Receiver<bool>,
    mut until: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    use crate::keeper_loop::{submit_and_wait, Sent};
    use crate::local_keeper as lk;
    let payer = crate::keeper_loop::fund_fresh(&state, &mut stop).await?;
    let me = payer.pubkey();
    let (mut anchors, mut ffs, mut failed) = (0u32, 0u32, 0u32);
    let mut sigs: BTreeMap<u64, [u8; 48]> = BTreeMap::new();
    let mut provinces: Vec<(i16, i16)> = vec![];
    let mut pass = 0u64;
    out(
        json!({"schema": WIDE_SCHEMA, "wide_step": "warm_keeper", "test_only": true, "payer": me.to_string()}),
    );
    let done = |stop: &tokio::sync::watch::Receiver<bool>,
                until: &tokio::sync::watch::Receiver<bool>| {
        *stop.borrow() || *until.borrow()
    };
    loop {
        if done(&stop, &until) {
            break;
        }
        if pass.is_multiple_of(30) {
            let c = lock(&state);
            provinces = crate::legacy_march::opened_provinces(&c, &a)
                .into_iter()
                .map(|(p, q)| (p as i16, q as i16))
                .collect();
        }
        pass += 1;
        let (clock, now, views) = {
            let c = lock(&state);
            let views: Vec<((i16, i16), lk::HomeView)> = provinces
                .iter()
                .filter_map(|&(p, q)| lk::view(&c, &a, p, q).ok().map(|v| ((p, q), v)))
                .collect();
            (lk::season_clock(&c, &a)?, c.unix_timestamp(), views)
        };
        let mut sent = 0u32;
        // 1. each ended turn's missing anchors, every region of the opened provinces at once
        let bell_now = views.iter().map(|(_, v)| v.bell_now).max().unwrap_or(0);
        let by_bell = {
            let c = lock(&state);
            let vs: Vec<lk::HomeView> = views.iter().map(|x| x.1).collect();
            anchor_plan(&vs, |rg, r| lk::missing_anchors(&c, &a, rg, r))
        };
        for (b, regions) in by_bell.into_iter().take(WARM_BELLS_PER_PASS) {
            if done(&stop, &until) {
                break;
            }
            let round = clock.tlock_round(b);
            if now < clock.drand.round_time(round) {
                continue;
            }
            let sig = match sigs.get(&round) {
                Some(s) => *s,
                None => match lk::fetch_round_at(round).await {
                    Ok(s) => {
                        sigs.insert(round, s);
                        while sigs.len() > 64 {
                            let k = *sigs.keys().next().expect("non-empty");
                            sigs.remove(&k);
                        }
                        s
                    }
                    Err(e) => {
                        failed += 1;
                        out(
                            json!({"schema": WIDE_SCHEMA, "wide_step": "warm_wait", "test_only": true, "why": e}),
                        );
                        break;
                    }
                },
            };
            let r = lk::RoundProvenance {
                bell: b,
                round,
                signature_hex: hex::encode(sig),
                source: format!("{}/public/{round}", lk::DRAND_URL),
                verified_against:
                    "fclient::beacon::quicknet_info().public_key (pinned Quicknet key)",
            };
            for mask in lk::region_masks(regions.into_iter()) {
                let ix = lk::post_anchor_multi_ix(&a, &me, mask, &r)?;
                let what = format!("PostAnchorMulti(bell {b}, mask {mask:#06x})");
                match submit_and_wait(
                    &state,
                    &payer,
                    ix,
                    &what,
                    std::time::Duration::from_secs(20),
                    &mut stop,
                )
                .await
                {
                    Sent::Landed(_) => {
                        anchors += mask.count_ones();
                        sent += 1;
                    }
                    other => {
                        failed += 1;
                        out(
                            json!({"schema": WIDE_SCHEMA, "wide_step": "warm_failed", "test_only": true, "what": what, "why": format!("{other:?}")}),
                        );
                    }
                }
            }
        }
        // 2. every province as far as its closed windows prove: the pass's FastForwards submitted together and awaited
        //    together (independent provinces, read-only anchors; one awaited transaction each took ~0.2 s, so 72 of them
        //    — the rim and heartland — outlasted a ×60 turn and the lag grew)
        let mut batch: Vec<(fclient::ports::Signature, String)> = vec![];
        {
            let mut c = lock(&state);
            for &(pq, _) in &views {
                if *stop.borrow() || *until.borrow() {
                    break;
                }
                let Ok(v) = lk::view(&c, &a, pq.0, pq.1) else {
                    continue;
                };
                let limit = v
                    .bell_now
                    .min(v.resolved_next.saturating_add(lk::MAX_FAST_FORWARD_BELLS));
                let to = lk::closed_through(&c, &a, v.region, v.resolved_next, limit)?;
                if to <= v.resolved_next {
                    continue;
                }
                let ix = lk::fast_forward_ix(&a, &me, pq.0, pq.1, &v, to)?;
                if !lk::simulate_ix(&c, &payer, &ix).is_ok_and(|x| x.err.is_none()) {
                    continue; // (not quiet: the keeper loop resolves it for real)
                }
                let what = format!(
                    "FastForward({}, {} {} -> {to})",
                    pq.0, pq.1, v.resolved_next
                );
                let (blockhash, _) = c.latest_blockhash();
                let t = fclient::tx::build(&[ix], &lk::budget(), &[&payer], &blockhash)?;
                match c.submit(&fclient::tx::wire(&t)) {
                    Ok(sig) => batch.push((sig, what)),
                    Err(e) => {
                        failed += 1;
                        out(
                            json!({"schema": WIDE_SCHEMA, "wide_step": "warm_failed", "test_only": true, "what": what, "why": e.to_string()}),
                        );
                    }
                }
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !batch.is_empty() && std::time::Instant::now() < deadline && !*stop.borrow() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let c = lock(&state);
            batch.retain(|(sig, what)| match c.transaction(sig) {
                Some(l) if l.err.is_none() => {
                    ffs += 1;
                    sent += 1;
                    false
                }
                Some(l) => {
                    failed += 1;
                    out(json!({"schema": WIDE_SCHEMA, "wide_step": "warm_failed", "test_only": true, "what": what, "why": format!("{:?} (code {:?})", l.err, l.code)}));
                    false
                }
                None if c.is_dropped(sig) => {
                    failed += 1;
                    false
                }
                None => true,
            });
        }
        // (an outcome still unknown is never resent: the next pass reads the province again)
        failed += batch.len() as u32;
        if pass % 10 == 1 {
            let behind = views
                .iter()
                .filter(|(_, v)| !frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now))
                .count();
            out(
                json!({"schema": WIDE_SCHEMA, "wide_step": "warm_status", "test_only": true, "bell": bell_now,
                "provinces": views.len(), "behind": behind, "anchors": anchors, "fast_forwards": ffs, "failed": failed}),
            );
        }
        if sent == 0 {
            tokio::select! {
                _ = tokio::time::sleep(WARM_TICK) => {}
                // (a dropped sender — the world ending, or the player's wait given up — ends the duty too)
                r = stop.changed() => if r.is_err() { break },
                r = until.changed() => if r.is_err() { break },
            }
        }
    }
    out(
        json!({"schema": WIDE_SCHEMA, "wide_step": "warm_keeper_done", "test_only": true, "anchors": anchors, "fast_forwards": ffs, "failed": failed}),
    );
    Ok(())
}

pub(crate) fn free_site(state: &Shared, a: &Addresses, p: i16, q: i16) -> Option<u8> {
    use frontier_abi::v2::layout::province::{province as PV, site as SM};
    let pd = read(state, &a.province(p as i32, q as i32), "province").ok()?;
    (0..pd[PV::SITE_COUNT] as usize)
        .find(|i| {
            matches!(
                pd[PV::site(*i) + SM::STATE],
                SM::STATE_FREE | SM::STATE_RELEASED_FREE
            )
        })
        .map(|i| i as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_anchor_plan_covers_every_region_from_its_least_turn_by_turn() {
        use crate::local_keeper::HomeView;
        let v = |resolved_next, bell_now, region| HomeView {
            resolved_next,
            bell_now,
            region,
        };
        // two rim provinces of region 4 (one 12 turns behind), one heartland province of region 9 (current)
        let views = [v(127, 139, 4), v(135, 139, 4), v(138, 139, 9)];
        assert_eq!(
            region_spans(&views),
            BTreeMap::from([(4, (127, 139)), (9, (138, 139))])
        );
        // every anchor absent but region 4's of turn 130
        let plan = anchor_plan(&views, |rg, r| {
            r.filter(|b| !(rg == 4 && *b == 130)).collect()
        });
        assert_eq!(plan.len(), 11, "turns 127..139 but 130 (landed already)");
        assert_eq!(plan[&127], vec![4]);
        assert!(!plan.contains_key(&130));
        assert_eq!(
            plan[&138],
            vec![4, 9],
            "one turn, both regions: one PostAnchorMulti"
        );
        assert!(plan.keys().all(|b| *b < 139), "only ended turns");
        // nothing missing: nothing to post
        assert!(anchor_plan(&views, |_, _| vec![]).is_empty());
        assert!(anchor_plan(&[], |_, r| r.collect()).is_empty());
    }

    #[test]
    fn the_option_is_exact() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            take_wide_args(a(&["--x", "1"])).unwrap(),
            (a(&["--x", "1"]), false)
        );
        assert_eq!(
            take_wide_args(a(&["--wide-land", WIDE_LAND_MODE, "--x"])).unwrap(),
            (a(&["--x"]), true)
        );
        assert!(take_wide_args(a(&["--wide-land", "wide"])).is_err());
        assert_eq!(take_wide_scale(a(&["--x"])).unwrap(), (a(&["--x"]), None));
        assert_eq!(
            take_wide_scale(a(&["--wide-scale", "60", "--x"])).unwrap(),
            (a(&["--x"]), Some(60))
        );
        for bad in ["0", "61", "06", "x", "-1"] {
            assert!(take_wide_scale(a(&["--wide-scale", bad])).is_err(), "{bad}");
        }
        assert!(take_wide_args(a(&["--wide-land"])).is_err());
        assert!(take_wide_args(a(&[
            "--wide-land",
            WIDE_LAND_MODE,
            "--wide-land",
            WIDE_LAND_MODE
        ]))
        .is_err());
    }

    #[test]
    fn the_season_is_the_devnet_wide_preset() {
        let p = params();
        let mut d = crate::wide_play::local_wide(S1_DEVNET_WIDE_7D);
        d.base.program_version = PROGRAM_VERSION;
        assert_eq!(p.to_bytes(), d.to_bytes());
        assert_eq!(p.cq.r_max_ceiling, R_MAX_HARD);
        assert_eq!(p.cq.placement, 2, "centre-free placement");
        // (the preset as published validates; this lane's runner then names the deployed artefact's version, as the
        //  natural world's params_for does)
        assert_eq!(S1_DEVNET_WIDE_7D.validate(), Ok(()));
        assert_eq!(p.base.program_version, PROGRAM_VERSION);
    }

    #[test]
    fn the_plan_is_per_wedge_contiguous_and_on_the_ring() {
        for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + WIDE_SEED_RINGS {
            let plan = wide_plan(ring, PER_WEDGE);
            assert_eq!(plan.len(), 6 * PER_WEDGE, "ring {ring}");
            for w in 0..6u8 {
                let v: Vec<_> = plan.iter().filter(|c| c.wedge() == Some(w)).collect();
                assert_eq!(v.len(), PER_WEDGE, "ring {ring} wedge {w}");
                for c in &v {
                    assert_eq!(c.ring(), ring);
                }
                // (contiguous: each next province is a hex neighbour of the one before)
                for pair in v.windows(2) {
                    let (dp, dq) = (pair[1].p() - pair[0].p(), pair[1].q() - pair[0].q());
                    assert!(
                        (dp.abs() + dq.abs() + (dp + dq).abs()) / 2 == 1,
                        "ring {ring} wedge {w}: {pair:?}"
                    );
                }
            }
            if ring == FIRST_WIDE_RING {
                let rim = rim_plan(&plan);
                assert!(rim.len() >= 6 * PER_WEDGE, "{}", rim.len());
                for (p, q) in &rim {
                    assert_eq!(ProvinceCoord::new(*p, *q).ring(), 128);
                }
            }
            let mut uniq = plan.clone();
            uniq.sort_by_key(|c| (c.p(), c.q()));
            uniq.dedup();
            assert_eq!(uniq.len(), plan.len());
        }
    }

    /// Q-W1: the devnet keeper's `rim_per_wedge` duty opens exactly this world's rim (the same provinces, in the
    /// same order), so local and devnet rim first villages stand beside the same wide provinces.
    #[test]
    fn the_keepers_rim_duty_opens_this_worlds_rim() {
        for n in [1, 3, PER_WEDGE, 12] {
            assert_eq!(
                keeper_core::rings::rim_plan(n),
                rim_plan(&wide_plan(FIRST_WIDE_RING, n)),
                "per_wedge {n}"
            );
        }
    }
}
