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
//! 5. the rest of the heartland is opened only now (so its provinces start resolved to the turn the player joins at,
//!    and the local keeper has nothing to catch up), one test participant per other nation places a home there, and
//!    the first province is brought up to now by the keeper's own PostAnchor / FastForward ([`catch_up`]).
//!
//! Every step is the program's own instruction; no account is written directly; no rule, parameter or program byte
//! changes beyond choosing the existing devnet preset for this local season. The clock after `ready-for-join` is the
//! natural world's (1x). Every line it prints says `test_only: true`.
use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::{ix, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::presets::{SeasonParamsV2, S1_DEVNET_WIDE_7D};
use frontier_abi::world_index::land::{self as wl, WideRingSeed, FIRST_WIDE_RING};
use frontier_abi::world_index::rules as wr;
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::WideCoord;
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};
use serde_json::{json, Value};

use crate::expedition_play::{PROGRAM, PROGRAM_VERSION};

pub const WIDE_LAND_MODE: &str = "local-wide-land-v1";
pub const WIDE_SCHEMA: &str = "frontier-localnet-wide-land-v1";
/// The wide rings opened: 129, 130, 131.
pub const WIDE_RINGS: u64 = 3;
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

/// The wide world's Season: the real `S1_DEVNET_WIDE_7D` with the deployed program's version.
pub fn params() -> SeasonParamsV2 {
    let mut p = S1_DEVNET_WIDE_7D;
    p.base.program_version = PROGRAM_VERSION;
    p
}

/// The wide provinces opened on `ring`: per wedge, the `per_wedge` provinces in the middle of that wedge's arc (in
/// the ring's walking order), wedges in order. Pure.
pub fn wide_plan(ring: u64, per_wedge: usize) -> Vec<WideCoord> {
    let r = ring as i64;
    let mut by_wedge: BTreeMap<u8, Vec<(f64, WideCoord)>> = BTreeMap::new();
    for p in -r..=r {
        for q in (-r).max(-p - r)..=r.min(-p + r) {
            let Ok(c) = WideCoord::checked(p, q) else {
                continue;
            };
            if c.ring() != ring {
                continue;
            }
            let Some(w) = c.wedge() else { continue };
            // (the axial position's angle: a stable order along the ring)
            let (x, y) = (
                p as f64 + q as f64 / 2.0,
                q as f64 * 0.866_025_403_784_438_6,
            );
            by_wedge.entry(w).or_default().push((y.atan2(x), c));
        }
    }
    let mut out = vec![];
    for (_, mut v) in by_wedge {
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        // (a wedge straddling the angle's wrap: walk it from its largest gap so the arc is contiguous)
        if v.len() > 1 {
            let gap = (0..v.len())
                .max_by(|&i, &j| {
                    let g = |k: usize| {
                        (v[(k + 1) % v.len()].0 - v[k].0).rem_euclid(std::f64::consts::TAU)
                    };
                    g(i).total_cmp(&g(j))
                })
                .unwrap_or(0);
            let n = v.len();
            v.rotate_left((gap + 1) % n);
        }
        let n = per_wedge.min(v.len());
        let from = (v.len() - n) / 2;
        out.extend(v[from..from + n].iter().map(|x| x.1));
    }
    out
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
fn wix_ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: Address::new_from_array(PROGRAM),
        accounts,
        data,
    }
}

/// 0xD6 WideRequestRingSeed: `[payer s,w] [season r] [frontier r] [previous ring seed r] [wide ring seed w]
/// [pfund × 6 r] [system]`.
pub fn request_ix(a: &Addresses, payer: Address, ring: u64) -> Instruction {
    let c = ctx(a);
    let previous = if ring == FIRST_WIDE_RING {
        a.ring_seed(R_MAX_HARD)
    } else {
        addr(wl::ring_seed_address(&c, ring - 1))
    };
    let mut m = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.frontier(), false),
        AccountMeta::new_readonly(previous, false),
        AccountMeta::new(addr(wl::ring_seed_address(&c, ring)), false),
    ];
    m.extend(
        a.province_funds()
            .into_iter()
            .map(|f| AccountMeta::new_readonly(f, false)),
    );
    m.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    wix_ix(m, wix::RequestRingSeed { ring }.to_bytes().to_vec())
}

/// 0xD7 WideConsumeRingSeed: `[payer s,w] [season r] [wide ring seed w]`.
pub fn consume_ix(
    a: &Addresses,
    payer: Address,
    ring: u64,
    round: u64,
    sig48: [u8; 48],
) -> Result<Instruction, String> {
    let hints: [u8; frontier_abi::ix::HINTS_LEN] = fclient::beacon::hints_bytes(round)
        .try_into()
        .map_err(|_| "hints length")?;
    Ok(wix_ix(
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(addr(wl::ring_seed_address(&ctx(a), ring)), false),
        ],
        wix::ConsumeRingSeed {
            ring,
            round,
            sig48,
            hints,
        }
        .to_bytes()
        .to_vec(),
    ))
}

/// 0xD8 WideOpenProvince: `[payer s,w] [season r] [wide ring seed w] [pfund w] [province w] [rules_config r] [system]`.
pub fn open_ix(a: &Addresses, payer: Address, coord: WideCoord) -> Result<Instruction, String> {
    let c = ctx(a);
    let wedge = coord.wedge().ok_or("a wide province has a wedge")?;
    Ok(wix_ix(
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(addr(wl::ring_seed_address(&c, coord.ring())), false),
            AccountMeta::new(a.province_fund(wedge), false),
            AccountMeta::new(addr(wl::province_address(&c, coord)), false),
            AccountMeta::new_readonly(addr(wr::rules_config_address(&c)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::OpenProvince {
            p: coord.p(),
            q: coord.q(),
        }
        .to_bytes()
        .to_vec(),
    ))
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
) -> Result<Value, String> {
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
    for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + WIDE_RINGS {
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
            // (the playable conquest world's rule bytes, as the devnet preset's test: interleaved keeps, the deployed
            //  Free City site, no camp, the sort-key-hash region)
            let rules = wr::RuleBytes {
                keep_holder: wr::KeepHolderRule::MixedInterleaved as u8,
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
        let plan = wide_plan(ring, PER_WEDGE);
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
    let caught_up = catch_up(state, a, payer, (first.0, first.1), &send, &advance_to).await?;
    step(
        "caught_up",
        json!({"province": [first.0, first.1], "resolved_next": caught_up}),
    );
    let summary = json!({
        "test_participants": settlers,
        "first_province_resolved_next": caught_up,
        "legacy_rings_opened": frontier_u16(state, a, FR::RINGS_OPENED)?,
        "r_max_ext": frontier_u16(state, a, FR::R_MAX_EXT)?,
        "rim_provinces": rim,
        "wide_rings": wide,
        "bell_at_ready": clock.bell_at(now()),
        "setup_secs": t0.elapsed().as_secs(),
    });
    step("done", summary.clone());
    Ok(summary)
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

/// The province opened before the growth is ~129 turns behind once the map is grown; the local keeper anchors at most
/// 16 turns ahead of a province per reveal window, so it would take over an hour to catch up. Here, still on the
/// synthetic setup clock, the keeper's own steps bring it up to now: PostAnchor for every ended turn (each round from
/// the public drand API, verified), the clock moved past their reveal windows, then FastForward as far as the closed
/// windows prove, 16 turns per transaction. Returns the province's `resolved_next` (resident: ≥ the turn − 1).
async fn catch_up(
    state: &Shared,
    a: &Addresses,
    payer: &Keypair,
    (p, q): (i16, i16),
    send: &impl Fn(&Shared, &[&Keypair], &[Instruction], &str) -> Result<String, String>,
    advance_to: &impl Fn(&Shared, i64) -> Result<(), String>,
) -> Result<u32, String> {
    use crate::local_keeper as lk;
    let clock = {
        let c = lock(state);
        lk::season_clock(&c, a)?
    };
    let view = || {
        let c = lock(state);
        lk::view(&c, a, p, q)
    };
    for _pass in 0..4 {
        let v = view()?;
        if frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now) {
            return Ok(v.resolved_next);
        }
        // (from a turn's start, so the windows close before the turn after next begins)
        advance_to(
            state,
            clock.genesis_ts + v.bell_now as i64 * fclient::abi::BELL_SECS + 1,
        )?;
        let v = view()?;
        let bells = {
            let c = lock(state);
            lk::missing_anchors(&c, a, v.region, v.resolved_next..v.bell_now)
        };
        let rounds: Vec<u64> = bells.iter().map(|b| clock.tlock_round(*b)).collect();
        let sigs = fetch_all(&rounds).await?;
        let mut close = 0i64;
        for (b, round) in bells.iter().zip(&rounds) {
            let r = lk::RoundProvenance {
                bell: *b,
                round: *round,
                signature_hex: hex::encode(sigs[round]),
                source: format!("{}/public/{round}", lk::DRAND_URL),
                verified_against:
                    "fclient::beacon::quicknet_info().public_key (pinned Quicknet key)",
            };
            send(
                state,
                &[payer],
                &[lk::post_anchor_ix(a, &payer.pubkey(), v.region, &r)?],
                &format!("PostAnchor(bell {b})"),
            )?;
        }
        for b in v.resolved_next..v.bell_now {
            let landed = {
                let c = lock(state);
                lk::anchor_landed(&c, a, b, v.region)?
            };
            if let Some(t) = landed {
                close = close.max(clock.reveal_close(b, t));
            }
        }
        advance_to(state, close + 1)?;
        loop {
            let v = view()?;
            let limit = v
                .bell_now
                .min(v.resolved_next.saturating_add(lk::MAX_FAST_FORWARD_BELLS));
            let to = {
                let c = lock(state);
                lk::closed_through(&c, a, v.region, v.resolved_next, limit)?
            };
            if to <= v.resolved_next {
                break;
            }
            send(
                state,
                &[payer],
                &[lk::fast_forward_ix(a, &payer.pubkey(), p, q, &v, to)?],
                &format!("FastForward(to {to})"),
            )?;
        }
    }
    let v = view()?;
    Ok(v.resolved_next)
}

fn free_site(state: &Shared, a: &Addresses, p: i16, q: i16) -> Option<u8> {
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
        let mut d = S1_DEVNET_WIDE_7D;
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
        for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + WIDE_RINGS {
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
}
