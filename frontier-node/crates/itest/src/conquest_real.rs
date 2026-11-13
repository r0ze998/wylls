//! TEST ONLY (ignored): the limited real-SBF conquest check on the isolated
//! conquest artefact (both lane markers), in an in-process memory-only chain
//! of this test (`launch_full`: two loopback ports from 41990–41997 (clear of the launcher's 41920–41933 and the expedition test's 41930–41937) for the
//! test's lifetime only; no persistent world, launcher, browser or existing
//! process; the player's key is a fresh in-memory test key). It establishes,
//! on real SBF:
//!
//! 1. the `local-conquest-test-v1` opening: real ConsumeRingSeed /
//!    SetRules(`CanonicalHashV1`) / WideOpenProvince, the Free City read back
//!    from this chain, and this start's `conquest_world` statement;
//! 2. a real Depart routed to the Free City's tile, the player's Reveal, and
//!    the keeper (with the conquest runner's resident bells) to the member
//!    settlement, exactly as `destination_real`;
//! 3. a wrapped DeclareSiege (kind 12, the 256 KiB heap frame of
//!    `prepare_conquest_declare`) signed by the player. On this natural-order
//!    chain the province is behind the current bell, so with the approved B
//!    rule (`CLAUDE-CONQUEST-RESERVATION-SPEC-20261112.md`) the program
//!    accepts it as a RESERVATION (it was `NotResident` before B). The
//!    strong-fixture test sends it and lets the keeper's ResolveWithConquest
//!    reach its bell, where the program applies it (or not) by its own rule.
//!    Not natural play: the fixture host is explicitly strong.
//!
//! Synthetic, stated: the initial fixture and the requested ring seed and test
//! authority (`launch_full`), the test chain's clock moved with its scale
//! control. Needs `WYLLS_CONQUEST_SBF`, `WYLLS_CONQUEST_SBF_SHA256` and
//! `WYLLS_PUBLIC_DRAND=1`. Nothing secret is printed.
use fclient::{Address, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::{
    expedition_transport::OwnedBridgeTransit, land::province_address, march::transit_address, ProvinceKey, TileAddress, WideCoord,
};
use localnet::server::lock;

use crate::destination_real::{advance, derive_route_to, keep_rx, masks_of, ports, raw_secs, reveal_ix, travel_upper};
use crate::expedition_play::{inspect, launch_full, PROGRAM, PROGRAM_VERSION, SEASON_ID};
use crate::keeper_loop::{public_quicknet, submit_and_wait, Pilot, Sent, LAND_TIMEOUT};
use crate::local_keeper as lk;
use crate::origin_driver::real_origin::real_depart_routed;

fn conquest_artifact() -> crate::expedition_play::Artifact {
    let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
    let path = std::path::PathBuf::from(need("WYLLS_CONQUEST_SBF"));
    let bytes = std::fs::read(&path).unwrap();
    let sha = need("WYLLS_CONQUEST_SBF_SHA256");
    crate::conquest_world::markers_ok(&bytes, &sha).expect("the conquest artefact carries both markers");
    inspect(path, bytes, &sha).unwrap()
}

/// The fixture host's troops as `Fixture::new` writes them (12 whole troops).
pub const FIXTURE_TROOPS_MILLI: u32 = 12_000;
/// The EXPLICITLY STRONG test fixture (not natural play): 3,000 whole troops,
/// ten times FRONTIER_7's `free_city_garrison` (300), well under the rules'
/// `MAX_HOST_TROOPS` (30,000). Chosen so the arrival can survive the generated
/// Free City's defence through the program's own combat; nothing else differs.
pub const STRONG_TROOPS_MILLI: u32 = 3_000_000;

const ARMS_I: usize = permutation_rules::frontier::arms::ARMS as usize;
const GOLD_I: usize = permutation_rules::frontier::holding::Resource::Gold as usize;
/// (value, rate, cap, t0) of one Accrual store of a v2 Holding.
fn store(hd: &[u8], i: usize) -> (i64, i64, i64, i64) {
    let o = frontier_abi::v2::layout::player::holding::STORES + 40 * i;
    let v = |k: usize| i64::from_le_bytes(hd[o + 8 * k..o + 8 * k + 8].try_into().unwrap());
    (v(0), v(1), v(2), v(3))
}
fn log_source_stores(c: &localnet::Chain, f: &crate::expedition_play::Fixture, when: &str) {
    let hd = c.account(&f.holding).unwrap().data;
    eprintln!("source Holding stores {when}: arms {:?} gold {:?} (value, rate, cap, t0; milli)", store(&hd, ARMS_I), store(&hd, GOLD_I));
}

/// SYNTHETIC initial fixture design for the STRONG case only, before any real
/// instruction: the fixture's source Holding is given exactly ONE
/// declaration's cost (`siege_cost()` arms plus the Season's
/// `siege_stake_gold`), value and cap equal, rate 0. Refused unless both stores
/// are the untouched fixture's (value 0, rate 0, cap 0). Not natural income:
/// the default fixture keeps empty stores and stays the Insufficient control.
fn provision_fixture_holding_for_one_declaration(state: &localnet::server::Shared, f: &crate::expedition_play::Fixture) -> (i64, i64) {
    let mut c = lock(state);
    let sd = c.account(&f.season).unwrap().data;
    let stake = frontier_abi::v2::presets::ConquestParams::of_season(&sd).expect("the Season's conquest params").siege_stake_gold as i64;
    let cost = permutation_rules::frontier::arms::siege_cost();
    let want = [(ARMS_I, cost[ARMS_I]), (GOLD_I, stake * 1000)];
    assert!(cost.iter().enumerate().all(|(i, x)| *x == 0 || i == ARMS_I), "siege_cost is arms only");
    let mut acc = c.account(&f.holding).expect("the fixture's source Holding");
    for (i, amount) in want {
        let (value, rate, cap, t0) = store(&acc.data, i);
        assert_eq!((value, rate, cap), (0, 0, 0), "only the untouched fixture store is provisioned");
        let o = frontier_abi::v2::layout::player::holding::STORES + 40 * i;
        acc.data[o..o + 8].copy_from_slice(&amount.to_le_bytes());
        acc.data[o + 16..o + 24].copy_from_slice(&amount.to_le_bytes());
        eprintln!("SYNTHETIC strong fixture: source store {i} value {value} -> {amount}, cap {cap} -> {amount} (milli; t0 {t0} kept, rate 0)");
    }
    c.set_account(f.holding, acc).unwrap();
    eprintln!("SYNTHETIC strong fixture: one declaration's cost provisioned: arms {} milli + gold stake {stake} whole", cost[ARMS_I]);
    (cost[ARMS_I], stake * 1000)
}

/// SYNTHETIC initial fixture design, before any real instruction touched the
/// host: the fixture's own roster entry in its home Province gets `troops`.
/// Refused unless the entry is exactly the fixture's (same host id, the
/// fixture's 12 troops), so it can never rewrite a played or resolved state.
fn strengthen_fixture_host(state: &localnet::server::Shared, f: &crate::expedition_play::Fixture, troops: u32) {
    use frontier_abi::entry::{find_entry, read_entry, write_entry};
    assert!(troops <= permutation_rules::frontier::host::MAX_HOST_TROOPS, "within the rules' host cap");
    let ctx = AddrCtx { program: PROGRAM, season: f.season.to_bytes() };
    let id = frontier_abi::world_index::expedition::AccountResolver::for_season(&ctx).unwrap().legacy_host_id(&f.host).unwrap();
    let mut c = lock(state);
    let mut acc = c.account(&f.home).expect("the fixture's home Province");
    let i = find_entry(&acc.data, id).expect("the fixture host's roster entry");
    let before = read_entry(&acc.data, i).unwrap();
    assert_eq!(before.troops, FIXTURE_TROOPS_MILLI, "only the untouched fixture entry is redesigned");
    write_entry(&mut acc.data, i, &frontier_abi::entry::Entry { troops, ..before }).unwrap();
    c.set_account(f.home, acc).unwrap();
    let after = read_entry(&c.account(&f.home).unwrap().data, i).unwrap();
    assert_eq!(after, frontier_abi::entry::Entry { troops, ..before }, "only the troops differ");
    eprintln!("SYNTHETIC strong fixture: host entry {i} troops {} -> {} (whole: {} -> {}); FRONTIER_7 free_city_garrison 300; MAX_HOST_TROOPS 30000",
        before.troops, troops, before.troops / 1000, troops / 1000);
}

#[test]
#[ignore]
fn a_real_conquest_world_states_its_free_city_and_a_natural_order_declaration_is_refused_not_resident() {
    scenario(None)
}

/// The same scenario with the EXPLICITLY STRONG fixture host
/// ([`STRONG_TROOPS_MILLI`]): a technical check of the conquest path on real
/// SBF, NOT natural play and NOT a full-heap or full-declaration proof.
#[test]
#[ignore]
fn with_an_explicitly_strong_fixture_host_the_arrival_meets_the_free_city_in_regular_combat() {
    scenario(Some(STRONG_TROOPS_MILLI))
}

/// The same strong fixture; after the reservation lands, the player's OWN real
/// resident Dissolve of the fixture's own host (sent once the province is
/// resolved to the bell before the reservation's) makes the host busy, so by
/// the program's own rule the reservation does not apply at its bell; the
/// keeper's SettleReservation then returns everything collected. Not natural
/// play; nothing about the reservation, the return or the cost is weakened.
#[test]
#[ignore]
fn with_an_explicitly_strong_fixture_host_a_reservation_whose_host_dissolves_is_not_applied_and_returned_in_full() {
    scenario_with(Some(STRONG_TROOPS_MILLI), Path::DissolveBeforeItsBell)
}

/// V2 route path (H1, H2, P2): the reservation message is the conquest prepare CLI's own bytes (the launcher's
/// relay budget by default: 1,000,000 CU, 67,108,864 loaded; 256 KiB heap), checked equal to the builder's, signed by the in-memory key and
/// sent; the preview CLI's observation of the host is asserted first. Same strong synthetic fixture; not
/// natural play. Needs WYLLS_PREVIEW_CLI(_SHA256) and WYLLS_CONQUEST_PREPARE_CLI(_SHA256).
#[test]
#[ignore]
fn with_an_explicitly_strong_fixture_host_the_cli_prepared_reservation_message_lands() {
    scenario_with(Some(STRONG_TROOPS_MILLI), Path::CliRoute)
}

/// H3, SYNTHETIC BRANCH (not natural play): the immediate DeclareSiege path on real SBF with a synthetic
/// current-bell cursor and a roster filled to its maximum, to measure the heap of the lead check's vectors.
#[test]
#[ignore]
fn h3_synthetic_cursor_immediate_declaration_with_a_full_roster_lands_on_real_sbf() {
    scenario_with(Some(STRONG_TROOPS_MILLI), Path::ImmediateH3)
}

/// F2: the runner metadata's `runner_instance` is the instance the served
/// `getSignatureStatuses` reports in `context.instance` (over real loopback
/// HTTP), 64 hex and not all zero; another method's context has no instance.
/// Real SBF launch only; no transaction is sent.
#[test]
#[ignore]
fn the_runner_metadata_instance_is_the_served_signature_status_instance() {
    let art = conquest_artifact();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (p, q) = ports(41_990);
        let player = Keypair::new();
        let play = launch_full(&art, player.pubkey(), p, q, false, false).await.unwrap();
        let want = play.metadata["runner_instance"].as_str().expect("metadata runner_instance").to_string();
        assert_eq!(want.len(), 64);
        assert!(want.bytes().all(|b| b.is_ascii_hexdigit()) && want != "0".repeat(64));
        let rpc = |method: &str, params: serde_json::Value| {
            let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
            let url = play.running.url();
            async move {
                let r = fclient::http::post_json(&url, &body).await.unwrap();
                assert_eq!(r.status, 200);
                serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()
            }
        };
        let st = rpc("getSignatureStatuses", serde_json::json!([["1".repeat(64)]])).await;
        assert_eq!(st["result"]["context"]["instance"].as_str(), Some(want.as_str()), "served instance = metadata");
        let bal = rpc("getBalance", serde_json::json!([player.pubkey().to_string()])).await;
        assert!(bal["result"]["context"].get("instance").is_none(), "only signature statuses carry it");
        eprintln!("runner_instance {}… equals the served context.instance", &want[..8]);
    });
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Path {
    Capture,
    DissolveBeforeItsBell,
    CliRoute,
    ImmediateH3,
}

/// Default fixture: the arrival is destroyed before any declaration (the
/// explicit settled-defeat gate), so only the strong fixture reaches step 3.
fn scenario(strong: Option<u32>) {
    scenario_with(strong, Path::Capture)
}

fn scenario_with(strong: Option<u32>, path: Path) {
    assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
    let art = conquest_artifact();
    let t0 = std::time::Instant::now();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (p, q) = ports(41_990);
        let player = Keypair::new();
        let mut play = launch_full(&art, player.pubkey(), p, q, false, true).await.unwrap();
        let state = play.running.state.clone();
        let plan = play.wide.take().expect("launched with the wide destination");
        let f = &play.fixture;
        let ctx = AddrCtx { program: PROGRAM, season: f.season.to_bytes() };
        let round_time = {
            let c = lock(&state);
            let s = fclient::decode::Season::decode(&c.account(&f.season).unwrap().data).unwrap();
            fclient::clock::SeasonClock::from_season(&s).drand.round_time(plan.round)
        };
        advance(&state, round_time + 1); // SYNTHETIC time: to the bound round
        let meta = |k: &str| play.metadata[k].as_str().unwrap().to_string();

        // 1. the preset's opening and its read-back on real SBF
        let cap = crate::conquest_world::open(state.clone(), plan, art.sha256(), &meta("program"), &meta("season"), &meta("rpc_url"), keep_rx(), |v| eprintln!("{v}"))
            .await
            .unwrap_or_else(|e| panic!("local-conquest-test-v1 opening: {e}"));
        eprintln!("conquest_world: {cap}");
        let site = cap["free_city"]["site"].as_u64().unwrap() as u8;
        let tile = cap["free_city"]["tile"].as_u64().unwrap() as u8;
        let dest = ProvinceKey::new(f.host.key().world(), WideCoord::checked(129, 0).unwrap());
        let dest_key = Address::new_from_array(province_address(&ctx, dest.coord()));
        let region = {
            let c = lock(&state);
            frontier_abi::world_index::land::WideProvince::read(&c.account(&dest_key).unwrap().data).unwrap().region
        };

        // the explicit test-only initial condition, before the Depart (none in the plain scenario)
        let mut provisioned = None;
        if let Some(troops) = strong {
            strengthen_fixture_host(&state, f, troops);
            provisioned = Some(provision_fixture_holding_for_one_declaration(&state, f));
        }

        // 2. a real route ending on the Free City's tile, Depart, Reveal, settlement
        let (origin, lands) = {
            use frontier_abi::v2::layout::player::holding as H;
            let c = lock(&state);
            let hd = c.account(&f.holding).unwrap().data;
            let home = c.account(&f.home).unwrap().data;
            let origin = TileAddress::new(f.host.key(), hd[H::TILE]).unwrap();
            (origin, vec![masks_of(dest, &c.account(&dest_key).unwrap().data), masks_of(f.host.key(), &home)])
        };
        let route = derive_route_to(origin, dest, &lands, Some(tile)).unwrap_or_else(|| panic!("no passable route ending on the Free City's tile {tile}"));
        let upper = travel_upper(&route.steps, &lands);
        let genesis_ts = f.genesis_ts;
        let (b0, arrive, sealed) = real_depart_routed(&state, f, &player, &route.dirs, route.dest_tile, |bell, now| {
            permutation_rules::frontier::travel::earliest_arrival_bell(genesis_ts, now, upper).max(bell + 5)
        });
        {
            let c = lock(&state);
            let external = Address::new_from_array(transit_address(&ctx, &f.holding.to_bytes(), 0));
            let t = OwnedBridgeTransit::from_bytes(&ctx, &c.account(&external).unwrap().data).unwrap().transit();
            let unit = frontier_abi::entry::unit_from_u8(t.unit).unwrap();
            let raw = raw_secs(&route.steps, &lands, permutation_rules::frontier::travel::is_cavalry(unit));
            let secs = permutation_rules::frontier::doctrine::of_faction_v3(t.faction).unwrap().travel_secs(raw as u64) as u32;
            permutation_rules::frontier::travel::check_arrival_bell(genesis_ts, t.depart_ts, secs, arrive).expect("the sealed arrival bell fits the route");
        }
        let mut pilot = Pilot::new(&state, public_quicknet(), Some(f.holding), keep_rx()).await.unwrap();
        let test_addrs = fclient::addr::Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let clock = { let c = lock(&state); lk::season_clock(&c, &test_addrs).unwrap() };
        advance(&state, clock.genesis_ts + 600 * (b0 as i64 + 1) + 5);
        let (mut origin_steps, mut revealed, mut settled) = (Vec::<String>::new(), false, false);
        for _ in 0..160 {
            assert!(pilot.tick(&state).await, "the keeper halted: {:?}", pilot.keeper.status);
            if let Some(s) = pilot.keeper.status.origin_step.clone() {
                if origin_steps.last() != Some(&s) {
                    origin_steps.push(s);
                }
            }
            let d = pilot.destination.as_ref().unwrap();
            if let Some(t) = d.terminal() {
                panic!("the destination driver stopped (an arrival on the Free City may not stay): {t:?}; {:?}", d.log);
            }
            if matches!(d.last_step(), Some(crate::destination_driver::Step::Settled { .. })) {
                settled = true;
                break;
            }
            if !revealed && origin_steps.iter().any(|s| s.starts_with("Landed(\"SettleOrigin")) {
                let payer = Keypair::new();
                lock(&state).airdrop(&payer.pubkey(), 5_000_000_000).unwrap();
                let faction = {
                    let c = lock(&state);
                    let external = Address::new_from_array(transit_address(&ctx, &f.holding.to_bytes(), 0));
                    OwnedBridgeTransit::from_bytes(&ctx, &c.account(&external).unwrap().data).unwrap().transit().faction
                };
                let ix = reveal_ix(&ctx, &payer.pubkey(), &f.holding, 0, faction, arrive, region, dest, &sealed, 0, &route);
                match submit_and_wait(&state, &payer, ix, "ExpeditionReveal(test player)", LAND_TIMEOUT, &mut keep_rx()).await {
                    Sent::Landed(_) => revealed = true,
                    other => panic!("the real Reveal: {other:?}"),
                }
                continue;
            }
            let now = lock(&state).unix_timestamp();
            advance(&state, now + 120); // SYNTHETIC time
        }
        assert!(settled, "not settled: {}", pilot.keeper.status.json());
        // the program's own record of this arrival: its fate and the settled bit
        let fate = {
            use frontier_abi::world_index::arrival::{clash_inputs_address, wide_clash_inputs, WideArrival, WideClashInputsHdr};
            let c = lock(&state);
            let faction = crate::expedition_play::FACTION;
            let inputs = c.account(&Address::new_from_array(clash_inputs_address(&ctx, dest, arrive))).expect("the arrival's ClashInputs").data;
            let h = WideClashInputsHdr::read(&inputs).unwrap();
            let pos = faction as usize * 4;
            assert!(h.flags & wide_clash_inputs::FLAG_RESOLVED != 0 && h.settled_mask & (1 << pos) != 0, "resolved and member-settled");
            WideArrival::read_at(&inputs, pos).unwrap().expect("the arrival's row").fate
        };
        eprintln!("arrival at the Free City: fate {fate}; member settlement landed: {:?}", pilot.destination.as_ref().unwrap().log.last());
        // the driver's completed step names the same fate; only a staying arrival may go on to a declaration
        let last = pilot.destination.as_ref().unwrap().last_step().cloned();
        assert_eq!(last, Some(crate::destination_driver::Step::Settled { fate }), "the driver's settled fate is the program's row");
        if !last.as_ref().is_some_and(|s| s.arrival_stays()) {
            panic!("the host's resolved fate is {fate} (1 Stays, 5 Destroyed) and its member settlement landed: a settled defeat, not an arrival or occupation; no declaration is attempted");
        }

        // (NOT_APPLIED and V2 route paths) the player acts inside the resident-order window of the
        // current bell N: resolved_next == N-1. The Dissolve needs it; the preview / prepare CLIs
        // refuse a host whose province is further behind (`ResolveBehind`, observed in V2's first
        // run), so V2 acts in the same legal window instead of changing any CLI or gate. The keeper
        // posts ended bells' anchors first; the SYNTHETIC test clock moves 30 s per tick. Bounded;
        // fails honestly if the window is not reached.
        if matches!(path, Path::DissolveBeforeItsBell | Path::CliRoute) {
            let mut reached = false;
            for _ in 0..600 {
                let (rn_now, bell_now) = {
                    let c = lock(&state);
                    let pd = c.account(&dest_key).unwrap().data;
                    (u32::from_le_bytes(pd[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap()),
                        clock.bell_at(c.unix_timestamp()).unwrap())
                };
                if rn_now + 1 == bell_now {
                    let now = lock(&state).unix_timestamp();
                    eprintln!("t+{:.1}s resident-order window: current bell {bell_now}, resolved_next {rn_now}, {}s into the bell",
                        t0.elapsed().as_secs_f32(), now - clock.genesis_ts - 600 * bell_now as i64);
                    reached = true;
                    break;
                }
                assert!(t0.elapsed().as_secs() < 120, "the resident-order window was not reached in time (resolved_next {rn_now}, bell {bell_now}): {}", pilot.keeper.status.json());
                assert!(pilot.tick(&state).await, "the keeper halted: {:?}", pilot.keeper.status);
                if let Some(step) = pilot.keeper.status.resident_step.as_deref().filter(|s| s.starts_with("Stopped") || s.starts_with("Unknown")) {
                    panic!("t+{:.1}s the resident driver stopped (not resent): {step}", t0.elapsed().as_secs_f32());
                }
                let now = lock(&state).unix_timestamp();
                advance(&state, now + 30); // SYNTHETIC test-clock step only
            }
            assert!(reached, "the resident-order window was not reached: {}", pilot.keeper.status.json());
        }
        if path == Path::ImmediateH3 {
            h3_immediate(&state, &ctx, f, &player, dest, &dest_key, site, &clock, t0);
            play.running.stop();
            return;
        }
        // 3. the player's wrapped DeclareSiege with the 256 KiB frame: simulated, then sent
        let (entry, now_bell, rn) = {
            let c = lock(&state);
            let pd = c.account(&dest_key).unwrap().data;
            let residents = crate::resident_bells::residents_of(&c, &test_addrs, dest, &pd, &f.holding).unwrap();
            let (entry, _, _) = residents.first().copied().expect("the host stays at the Free City's province");
            let rn = u32::from_le_bytes(pd[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap());
            (entry as u8, clock.bell_at(c.unix_timestamp()).unwrap(), rn)
        };
        let draft = fclient::wide_conquest_draft::Draft::declare_siege(&ctx, f.host, dest, site, entry, player.pubkey()).unwrap();
        let mut cli_reports = serde_json::Value::Null;
        let wire = if path == Path::CliRoute {
            let (w, reports) = cli_route_wire(&state, &ctx, f, &player, dest, site, entry, &play.running.url());
            cli_reports = reports;
            w
        } else {
            use fclient::experimental_expedition_message::{prepare_conquest_declare, Target, CONQUEST_DECLARE_HEAP_FRAME};
            use fclient::tx::{self, TxBudget};
            use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
            let c = lock(&state);
            let (blockhash, last_valid) = c.latest_blockhash();
            let obs = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100),
                last_valid_block_height: last_valid };
            let budget = TxBudget { cu_limit: 1_400_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(CONQUEST_DECLARE_HEAP_FRAME) };
            let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
            let prepared = prepare_conquest_declare(&draft, Target { program: Address::new_from_array(PROGRAM), season: f.season, program_version: PROGRAM_VERSION },
                obs, budget, limits).unwrap();
            tx::wire(&tx::sign(prepared.message().clone(), &[&player]).unwrap())
        };
        let sim = lock(&state).simulate(&wire, true).unwrap();
        eprintln!("DeclareSiege(site {site}, entry {entry}) at bell {now_bell}, resolved_next {rn}: err {:?} code {:?}, {} CU", sim.err, sim.code, sim.units);
        for l in &sim.logs {
            eprintln!("  {l}");
        }
        assert!(rn < now_bell, "natural order: the province is not resolved through the current bell");
        if sim.err.is_some() {
            eprintln!("DIAG player (payer) lamports {}", lock(&state).account(&player.pubkey()).map(|a| a.lamports).unwrap_or(0));
            diagnose_reservation(&lock(&state), &ctx, f, dest, &dest_key, site, entry, now_bell);
        }
        assert!(sim.err.is_none(), "B: a lagged declaration is accepted as a reservation (code {:?})", sim.code);
        // send it (the player's own signed decision), wait for it to land
        let mut evidence: Vec<serde_json::Value> = Vec::new();
        let sig = lock(&state).submit(&wire).expect("the reservation submitted");
        let mut landed = false;
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let c = lock(&state);
            if let Some(l) = c.transaction(&sig) {
                assert!(l.err.is_none(), "the reservation failed: {:?} code {:?}", l.err, l.code);
                landed = true;
                break;
            }
        }
        assert!(landed, "the reservation did not land (outcome unknown; not resent)");
        // the reservation's real receipts, from this transaction's own log (not the synthetic vectors)
        {
            let c = lock(&state);
            let l = c.transaction(&sig).expect("the landed reservation");
            assert!(l.err.is_none());
            let rs = conquest_receipts(&ctx, &l.logs);
            eprintln!("RECEIPTS of the reservation tx {sig}: {rs:?}");
            assert!(rs.iter().any(|r| r.0 == "PSW1" && r.1 == "ConquestDeclared" && r.2 == frontier_abi::world_index::event::conquest::RESERVE && r.3 == now_bell),
                "a ConquestDeclared record with receipt action 8 (RESERVE) at bell {now_bell}");
            assert!(rs.iter().any(|r| r.2 == frontier_abi::world_index::event::conquest::RESERVE && (r.1 == "ConquestDebited" || r.1 == "LegacySourceDebit")),
                "the source Holding's debit record carries the same RESERVE receipt");
        }
        let table_of = |c: &localnet::Chain| {
            let t = c.account(&Address::new_from_array(frontier_abi::world_index::conquest::conquest_address(&ctx, dest))).expect("the conquest table");
            frontier_abi::world_index::conquest::WideConquest::read(&t.data, SEASON_ID, dest).unwrap()
        };
        {
            let c = lock(&state);
            log_source_stores(&c, f, "after the reservation landed (collected at signature)");
            let t = table_of(&c);
            let p = t.pending_at(site, now_bell);
            assert_eq!(p.len(), 1, "one PENDING reservation for bell {now_bell}");
            let r = p[0].1;
            // the full cost is collected at signature and recorded exactly
            let (arms, gold) = provisioned.expect("only the strong fixture reaches a declaration");
            let hd = c.account(&f.holding).unwrap().data;
            assert_eq!((store(&hd, ARMS_I).0, store(&hd, GOLD_I).0), (0, 0), "arms and gold collected in full from the source");
            assert_eq!((r.arms_milli as i64, r.gold_milli as i64), (arms, gold), "the reservation records exactly what it collected");
            eprintln!("reservation landed: seq {} bell {} slot {} gold {} milli arms {} milli; site entry {:?}", r.seq, r.bell, r.reserved_slot, r.gold_milli, r.arms_milli, t.entry(site).unwrap().is_some());
            let prefix = frontier_abi::conquest_model::Record::read(&c.account(&dest_key).unwrap().data, site as usize).unwrap();
            assert_eq!(prefix.flags, frontier_abi::v2::layout::province::conquest::FLAG_PENDING);
            evidence.push(snapshot(&c, &ctx, f, dest, &dest_key, site, "reservation_pending", now_bell));
        }
        if path == Path::DissolveBeforeItsBell {
            not_applied_and_returned(&state, &mut pilot, &ctx, f, &player, dest, &dest_key, site, now_bell, provisioned.unwrap(), &clock, t0, &mut evidence).await;
            write_evidence(&evidence, &serde_json::Value::Null, &ctx, f, &player.pubkey(), dest, art.sha256());
            play.running.stop();
            return;
        }
        // 4. the keeper resolves the destination's bells with conquest; at the
        //    reservation's bell the program applies it, or not, by its rule
        let mut outcome = None;
        for _ in 0..120 {
            assert!(pilot.tick(&state).await, "the keeper halted: {:?}", pilot.keeper.status);
            {
                let c = lock(&state);
                let t = table_of(&c);
                let pd = c.account(&dest_key).unwrap().data;
                let rn_now = u32::from_le_bytes(pd[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap());
                if rn_now > now_bell {
                    let applied = t.entry(site).unwrap();
                    let owed: Vec<_> = t.reservations().iter().flatten().copied().collect();
                    outcome = Some((rn_now, applied, owed));
                    break;
                }
            }
            let now = lock(&state).unix_timestamp();
            advance(&state, now + 120); // SYNTHETIC time
        }
        let (rn_now, applied, owed) = outcome.unwrap_or_else(|| panic!("bell {now_bell} not resolved: {}", pilot.keeper.status.json()));
        eprintln!("after resolving through bell {} : site entry {:?}; reservation records {:?}", rn_now - 1, applied, owed);
        // this case verifies the success path: the reservation MUST apply
        let e = applied.unwrap_or_else(|| panic!("the reservation did not apply at bell {now_bell} (records {owed:?}): the success path is not shown"));
        assert_eq!(e.declaration_bell, now_bell, "applied as the declaration of its own bell");
        assert!(owed.is_empty(), "the applied record is freed");
        let slot = e.reserved_slot;
        {
            let c = lock(&state);
            evidence.push(snapshot(&c, &ctx, f, dest, &dest_key, site, "reservation_applied", now_bell));
        }
        eprintln!("t+{:.1}s APPLIED: siege entry kind {} progress {}/{} slot {slot}", t0.elapsed().as_secs_f32(), e.rules.kind, e.rules.progress, e.rules.required);
        if path == Path::CliRoute {
            // V2 ends at the application: the route's own bytes reserved and applied
            write_evidence(&evidence, &cli_reports, &ctx, f, &player.pubkey(), dest, art.sha256());
            play.running.stop();
            return;
        }
        // 5. the siege runs its bells (the keeper resolves with conquest; the
        //    program's own model advances it) and the keeper's crank settles a
        //    won capture. Stops inside the 60 s cap and names the stage reached.
        let target = Address::new_from_array(frontier_abi::world_index::holding::holding_address(&ctx, dest.coord(), site));
        let mut last = (0u32, 255u8, 0u8);
        let mut captured = false;
        let mut due_snapped = false;
        // stop cleanly before the run script's hard cap (60 s default; the
        // separately named 120 s script sets 112)
        let deadline: u64 = std::env::var("WYLLS_REAL_DEADLINE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(52);
        for _ in 0..2000 {
            if t0.elapsed().as_secs() >= deadline {
                break;
            }
            assert!(pilot.tick(&state).await, "the keeper halted: {:?}", pilot.keeper.status);
            // a stopped resident driver never resends: fail now instead of waiting out the cap
            if let Some(step) = pilot.keeper.status.resident_step.as_deref().filter(|s| s.starts_with("Stopped") || s.starts_with("Unknown")) {
                panic!("t+{:.1}s the resident driver stopped (not resent): {step}", t0.elapsed().as_secs_f32());
            }
            let (rn_now, entry, holding_present) = {
                let c = lock(&state);
                let pd = c.account(&dest_key).unwrap().data;
                let rn_now = u32::from_le_bytes(pd[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap());
                (rn_now, table_of(&c).entry(site).unwrap(), c.account(&target).is_some())
            };
            let now_state = entry.map_or((rn_now, 255, 0), |e| (rn_now, e.rules.kind, e.rules.progress));
            if now_state != last {
                eprintln!("t+{:.1}s resolved_next {rn_now}: entry {:?}; target Holding present {holding_present}", t0.elapsed().as_secs_f32(),
                    entry.map(|e| (e.rules.kind, e.rules.progress, e.rules.required, e.rules.bell)));
                last = now_state;
            }
            if !due_snapped && entry.is_some_and(|e| e.rules.kind == frontier_abi::v2::layout::province::conquest::KIND_CAPTURE_DUE) {
                let c = lock(&state);
                evidence.push(snapshot(&c, &ctx, f, dest, &dest_key, site, "capture_due", now_bell));
                due_snapped = true;
            }
            if entry.is_none() && holding_present {
                captured = true;
                break;
            }
            if let Some(e) = entry {
                assert_ne!(e.rules.kind, frontier_abi::v2::layout::province::conquest::KIND_NONE, "the siege failed by the program's model (honest outcome; no capture)");
            }
            // SYNTHETIC test-clock step only (no game rule changes): 200 s per
            // tick = three keeper transactions per 600 s bell (anchor, seed, resolve)
            let now = lock(&state).unix_timestamp();
            advance(&state, now + 200);
        }
        if !captured {
            panic!("STAGE REACHED at the test's own {deadline} s stop (before the run script's hard cap): siege state {last:?} (resolved_next, kind, progress) of required {}; capture not reached in this run; keeper: {}",
                e.rules.required, pilot.keeper.status.json());
        }
        // 6. the capture as the program left it: a new Holding at the site, the
        //    Citizen's reserved slot bound to it, the escrow binding consumed
        {
            use frontier_abi::v2::layout::player::citizen as C;
            let c = lock(&state);
            let h = c.account(&target).unwrap();
            assert_eq!(h.owner, Address::new_from_array(PROGRAM));
            let cd = c.account(&f.citizen).unwrap().data;
            let binding = frontier_abi::world_index::holding::binding_of(&cd, slot);
            eprintln!("t+{:.1}s CAPTURED: Holding {target} ({} bytes); Citizen slot {slot} binding {binding:?}; slots byte {:#04x}; keeper {}",
                t0.elapsed().as_secs_f32(), h.data.len(), cd[C::SLOTS], pilot.keeper.status.json());
            assert!(matches!(binding, Ok(frontier_abi::world_index::holding::SlotBinding::Wide)), "the reserved slot is bound to the new wide Holding");
            let escrow = c.account(&Address::new_from_array(frontier_abi::world_index::conquest::capture_escrow_address(&ctx, &f.citizen.to_bytes())));
            if let Some(x) = escrow {
                let w = frontier_abi::world_index::conquest::WideCaptureEscrow::read(&x.data, SEASON_ID, dest.world(), f.citizen.to_bytes()).unwrap();
                assert!(w.binding(slot).unwrap().is_none(), "the escrow binding is consumed by the capture");
            }
            // the SettleCapture transaction the keeper's crank landed, and its real receipts
            let r = pilot.resident.as_ref().expect("the resident bells driver");
            let line = r.log.iter().rev().find(|l| l.contains("Landed(\"SettleCapture")).cloned()
                .unwrap_or_else(|| panic!("no landed SettleCapture in the keeper log: {:?}", r.log.iter().rev().take(5).collect::<Vec<_>>()));
            let sig_str = line.rsplit('"').nth(1).expect("the signature in the log line").to_string();
            let cap_sig = sig_str.parse().expect("a signature");
            let l = c.transaction(&cap_sig).expect("the landed SettleCapture");
            assert!(l.err.is_none());
            let rs = conquest_receipts(&ctx, &l.logs);
            eprintln!("RECEIPTS of the SettleCapture tx {cap_sig}: {rs:?}");
            assert!(rs.iter().any(|r| r.0 == "PSW1" && r.1 == "ConquestCaptured" && r.2 == frontier_abi::world_index::event::conquest::CAPTURE),
                "a ConquestCaptured record with receipt action 5 (CAPTURE)");
            evidence.push(snapshot(&c, &ctx, f, dest, &dest_key, site, "captured", now_bell));
        }
        write_evidence(&evidence, &serde_json::Value::Null, &ctx, f, &player.pubkey(), dest, art.sha256());
        play.running.stop();
    });
}

/// TEST-ONLY diagnosis of a refused reservation: replays the handler's pure
/// ABI steps on THIS chain's real accounts and prints the first that errors.
/// Reads only; changes nothing; proves nothing about the program by itself.
#[allow(clippy::too_many_arguments)]
fn diagnose_reservation(c: &localnet::Chain, ctx: &AddrCtx, f: &crate::expedition_play::Fixture, dest: ProvinceKey, dest_key: &Address, site: u8, entry: u8, bell: u32) {
    use frontier_abi::conquest_model::Record;
    use frontier_abi::v2::layout::player::citizen as C;
    use frontier_abi::world_index::conquest::{self as wc, Reservation, WideCaptureEscrow, WideConquest, CaptureBinding, RES_PENDING};
    use frontier_abi::world_index::roster::{roster_address, WideRoster};
    let pd = c.account(dest_key).unwrap().data;
    let n = pd[frontier_abi::v2::layout::province::province::SITE_COUNT] as usize;
    let empty = WideConquest::new(SEASON_ID, dest, [1; 32]).unwrap();
    for s in 0..frontier_abi::v2::layout::province::province::SITES_N {
        let r = Record::read(&pd, s).unwrap();
        let v = empty.validate_paired(s as u8, r);
        if v.is_err() || r != Record::ZERO {
            eprintln!("DIAG site {s} (count {n}): {r:?} -> paired(empty) {v:?}");
        }
    }
    let rd = c.account(&Address::new_from_array(roster_address(ctx, dest))).unwrap().data;
    let roster = WideRoster::read(&rd).unwrap();
    let host = roster.ref_at(&rd, entry as usize);
    eprintln!("DIAG roster ref_at({entry}) = {host:?}; fixture host {:?}", f.host);
    let cd = c.account(&f.citizen).unwrap().data;
    let citizen = f.citizen.to_bytes();
    let faction = cd[C::FACTION];
    {
        use frontier_abi::v2::layout::world::season as S;
        let sd = c.account(&f.season).unwrap().data;
        let sid = u64::from_le_bytes(sd[S::SEASON_ID..S::SEASON_ID + 8].try_into().unwrap());
        let ctx_world = frontier_abi::world_index::WorldId::derive_legacy_season(&ctx.season, &ctx.program);
        let stored_tag = u64::from_le_bytes(cd[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].try_into().unwrap());
        eprintln!("DIAG season id real {sid} vs SEASON_ID {SEASON_ID}; dest world == ctx world: {:?}; citizen tag stored {stored_tag:#x} computed {:#x}; citizen len {} (C::SIZE {}); slots {:#04x}",
            ctx_world.map(|w| w == dest.world()), frontier_abi::addr::citizen_tag(&citizen), cd.len(), C::SIZE, cd[C::SLOTS]);
        let e = WideCaptureEscrow::new(sid, dest.world(), citizen, [2; 32]).unwrap();
        eprintln!("DIAG validate_inventory with the real season id -> {:?}", e.validate_inventory(sid, dest.world(), citizen, &cd));
        // the source Holding's stores the declaration pays from (value, rate, cap, t0 per resource)
        let hd = c.account(&f.holding).unwrap().data;
        for (i, name) in [(4usize, "arms(horses slot)"), (5, "gold")] {
            let o = frontier_abi::v2::layout::player::holding::STORES + 40 * i;
            let v = |k: usize| i64::from_le_bytes(hd[o + 8 * k..o + 8 * k + 8].try_into().unwrap());
            eprintln!("DIAG source store {name}: value {} rate {} cap {} t0 {}", v(0), v(1), v(2), v(3));
        }
    }
    let Ok(Some(host)) = host else { return };
    let prefix = Record::read(&pd, site as usize).unwrap();
    for slot in [2u8, 3] {
        let r = Reservation {
            status: RES_PENDING, site, entry, reserved_slot: slot, faction, done: 0, bell, seq: 0, citizen, host,
            actor_tag: frontier_abi::addr::citizen_tag(&citizen), gold_milli: 1, arms_milli: 1,
        };
        let res = empty.reserve(prefix, r);
        eprintln!("DIAG slot {slot}: reserve -> {:?}; source {:?}", res.as_ref().map(|x| x.2.seq), r.source());
        let world = dest.world();
        let e = WideCaptureEscrow::new(SEASON_ID, world, citizen, [2; 32]).unwrap();
        eprintln!("DIAG slot {slot}: escrow.validate_inventory(before mark) -> {:?}", e.validate_inventory(SEASON_ID, world, citizen, &cd));
        let b = CaptureBinding { key: dest, site, gen: 0, declaration_bell: bell };
        let er = e.reserve(slot, b, 1_000_000, [3; 32]);
        let mut cd2 = cd.clone();
        let m = wc::mark(&mut cd2, slot);
        eprintln!("DIAG slot {slot}: escrow.reserve -> {:?}; mark -> {m:?}", er.as_ref().map(|x| x.1));
        if let (Ok((t, _, rr)), Ok((eo, _)), Ok(())) = (&res, &er, &m) {
            eprintln!("DIAG slot {slot}: validate_paired_reservation -> {:?}", eo.validate_paired_reservation(t, rr.seq, citizen, &cd2));
        }
    }
}

/// The conquest receipts in ONE landed transaction's own log lines ("Program
/// data:" fields): (channel, record kind, receipt action, bell). Decoded with
/// the ABI's own codecs; anything not decodable is listed as such, never guessed.
fn conquest_receipts(ctx: &AddrCtx, logs: &[String]) -> Vec<(String, String, u8, u32)> {
    use base64::Engine as _;
    use frontier_abi::world_index::{event, legacy_source_event as le};
    let b64 = base64::engine::general_purpose::STANDARD;
    let resolver = frontier_abi::world_index::expedition::AccountResolver::for_season(ctx).unwrap();
    let mut out = Vec::new();
    for line in logs {
        let Some(rest) = line.strip_prefix("Program data: ") else { continue };
        let fields: Vec<Vec<u8>> = rest.split(' ').filter_map(|x| b64.decode(x).ok()).collect();
        if fields.len() != 2 {
            continue;
        }
        if fields[0] == event::WIDE_LOG_PREFIX {
            match event::WideRecord::decode(&fields[1]) {
                Ok(r) if r.kind.conquest() => {
                    let rc = event::conquest::Receipt::decode(r.payload).unwrap();
                    out.push(("PSW1".into(), format!("{:?}", r.kind), rc.action, r.bell));
                }
                Ok(r) => out.push(("PSW1".into(), format!("{:?}", r.kind), 0, r.bell)),
                Err(e) => out.push(("PSW1".into(), format!("undecodable {e:?}"), 0, 0)),
            }
        } else if fields[0] == le::PREFIX && fields[1].get(1) == Some(&le::KIND) {
            match le::Record::decode(&resolver, &fields[1]) {
                Ok(r) => out.push(("PS2".into(), format!("LegacySource{:?}", r.source.direction), r.source.receipt.action, r.source.bell)),
                Err(e) => out.push(("PS2".into(), format!("undecodable {e:?}"), 0, 0)),
            }
        }
    }
    out
}

/// TEST-ONLY public account evidence for the Fable reader: the conquest table,
/// the destination Province and the Citizen exactly as this chain holds them
/// (addresses, owners, lamports, base64 bytes). Public data only; no key.
fn snapshot(c: &localnet::Chain, ctx: &AddrCtx, f: &crate::expedition_play::Fixture, dest: ProvinceKey, dest_key: &Address, site: u8, stage: &str, bell: u32) -> serde_json::Value {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let table = Address::new_from_array(frontier_abi::world_index::conquest::conquest_address(ctx, dest));
    let acct = |k: &Address| match c.account(k) {
        Some(a) => serde_json::json!({"address": k.to_string(), "owner": a.owner.to_string(), "lamports": a.lamports, "executable": a.executable, "bytes": a.data.len(), "data_base64": b64.encode(&a.data)}),
        None => serde_json::json!({"address": k.to_string(), "absent": true}),
    };
    serde_json::json!({"stage": stage, "reservation_bell": bell, "slot": c.slot(), "unix_timestamp": c.unix_timestamp(),
        "conquest_table": acct(&table), "province": acct(dest_key), "citizen": acct(&f.citizen),
        "target_holding": acct(&Address::new_from_array(frontier_abi::world_index::holding::holding_address(ctx, dest.coord(), site)))})
}
/// Writes the evidence only when `WYLLS_REAL_EVIDENCE` names a file.
fn write_evidence(snaps: &[serde_json::Value], cli: &serde_json::Value, ctx: &AddrCtx, f: &crate::expedition_play::Fixture, wallet: &Address, dest: ProvinceKey, artifact_sha256: &str) {
    let Ok(path) = std::env::var("WYLLS_REAL_EVIDENCE") else { return };
    let doc = serde_json::json!({
        "schema": "claude-conquest-reservation-real-evidence-v1",
        "synthetic": "memory-only test chain; SYNTHETIC initial state (strong fixture host, one declaration's cost provisioned, Season/Citizen/Holding fixture); every later byte written by the real SBF program; not natural play; heapConfirmed/pageBinding stay false",
        "artifact_sha256": artifact_sha256,
        "program": Address::new_from_array(ctx.program).to_string(),
        "season": f.season.to_string(),
        "season_id": SEASON_ID,
        "world_hex": dest.world().as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "province": {"p": dest.coord().p(), "q": dest.coord().q()},
        "player_wallet_public_key": wallet.to_string(),
        "citizen": f.citizen.to_string(),
        "snapshots": snaps,
        "cli": cli,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap()).expect("write the evidence file");
    eprintln!("EVIDENCE written: {path}");
}

/// The NOT_APPLIED path on real SBF (see the test's doc). Asserts the program's
/// own outcome and the full return; never fabricates a state.
#[allow(clippy::too_many_arguments)]
async fn not_applied_and_returned(state: &localnet::server::Shared, pilot: &mut Pilot, ctx: &AddrCtx, f: &crate::expedition_play::Fixture,
    player: &Keypair, dest: ProvinceKey, dest_key: &Address, site: u8, bell: u32, provisioned: (i64, i64), clock: &fclient::clock::SeasonClock,
    t0: std::time::Instant, evidence: &mut Vec<serde_json::Value>) {
    use frontier_abi::v2::layout::player::citizen as C;
    use frontier_abi::world_index::conquest::{capture_escrow_address, conquest_address, WideCaptureEscrow, WideConquest, RES_NOT_APPLIED};
    let deadline: u64 = std::env::var("WYLLS_REAL_DEADLINE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(52);
    let rn_of = |c: &localnet::Chain| u32::from_le_bytes(c.account(dest_key).unwrap().data[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap());
    let table_of = |c: &localnet::Chain| WideConquest::read(&c.account(&Address::new_from_array(conquest_address(ctx, dest))).unwrap().data, SEASON_ID, dest).unwrap();
    let escrow_addr = Address::new_from_array(capture_escrow_address(ctx, &f.citizen.to_bytes()));

    // a. the keeper resolves to bell-1 while the clock stays INSIDE the reservation's bell: the
    //    SYNTHETIC test clock moves in 30 s steps only if the next time is still in that bell
    for _ in 0..200 {
        if rn_of(&lock(state)) >= bell - 1 {
            break;
        }
        assert!(pilot.tick(state).await, "the keeper halted: {:?}", pilot.keeper.status);
        if let Some(step) = pilot.keeper.status.resident_step.as_deref().filter(|s| s.starts_with("Stopped") || s.starts_with("Unknown")) {
            panic!("t+{:.1}s the resident driver stopped (not resent): {step}", t0.elapsed().as_secs_f32());
        }
        let now = lock(state).unix_timestamp();
        if clock.bell_at(now + 30) == Some(bell) {
            advance(state, now + 30); // SYNTHETIC test-clock step only, never past the bell
        }
    }
    let (rn, now_bell) = {
        let c = lock(state);
        (rn_of(&c), clock.bell_at(c.unix_timestamp()).unwrap())
    };
    eprintln!("t+{:.1}s before the Dissolve: resolved_next {rn}, current bell {now_bell}, reservation bell {bell}", t0.elapsed().as_secs_f32());
    if (rn, now_bell) != (bell - 1, bell) {
        let now = lock(state).unix_timestamp();
        panic!("resident order window not reached: resolved_next {rn}, current bell {now_bell} (wanted {}, {bell}); {}s into bell {now_bell} (bell length 600 s); keeper: {}",
            bell - 1, now - clock.genesis_ts - 600 * now_bell as i64, pilot.keeper.status.json());
    }
    let (cd0, stores0, esc0) = {
        let c = lock(state);
        let hd = c.account(&f.holding).unwrap().data;
        (c.account(&f.citizen).unwrap().data, (store(&hd, ARMS_I).0, store(&hd, GOLD_I).0), c.account(&escrow_addr).unwrap())
    };
    assert_eq!(stores0, (0, 0), "before the return the collected cost is out of the source");

    // b. the player's own real Dissolve of the fixture's own host (resident order, 256 KiB frame)
    let wire = {
        use fclient::experimental_expedition_message::{prepare_resident, Target, RESIDENT_HEAP_FRAME};
        use fclient::tx::{self, TxBudget};
        use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
        use frontier_abi::world_index::{expedition_dispatch_ix::Kind, wide_ix as wix};
        let draft = fclient::wide_resident_draft::Draft::for_wallet(ctx, f.host, dest, player.pubkey(), player.pubkey()).unwrap();
        let c = lock(state);
        let (blockhash, last_valid) = c.latest_blockhash();
        let obs = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100),
            last_valid_block_height: last_valid };
        let budget = TxBudget { cu_limit: 1_400_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(RESIDENT_HEAP_FRAME) };
        let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
        let prepared = prepare_resident(&draft, Target { program: Address::new_from_array(PROGRAM), season: f.season, program_version: PROGRAM_VERSION },
            obs, budget, limits).unwrap();
        // the program instruction is the versioned dispatch wrapper of kind 4 (Dissolve)
        let m = prepared.message();
        let ix = m.instructions.iter().find(|i| m.account_keys[i.program_id_index as usize] == Address::new_from_array(PROGRAM)).expect("the program instruction");
        assert_eq!(&ix.data[..4], &[wix::TAG_DEPART, wix::ENVELOPE_ESCAPE, 2, Kind::Dissolve as u8], "dispatch v2 kind 4 = Dissolve");
        tx::wire(&tx::sign(m.clone(), &[player]).unwrap())
    };
    let sim = lock(state).simulate(&wire, true).unwrap();
    eprintln!("Dissolve(own host) at bell {now_bell}, resolved_next {rn}: err {:?} code {:?}, {} CU", sim.err, sim.code, sim.units);
    assert!(sim.err.is_none(), "the player's Dissolve is accepted (code {:?})", sim.code);
    let sig = lock(state).submit(&wire).expect("the Dissolve submitted");
    let mut landed = false;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Some(l) = lock(state).transaction(&sig) {
            assert!(l.err.is_none(), "the Dissolve failed: {:?}", l.err);
            landed = true;
            break;
        }
    }
    assert!(landed, "the Dissolve did not land (outcome unknown; not resent)");
    // the escrow ledger and the funder's balance AFTER the player's own Dissolve fee was paid
    let (escrow_ledger0, funder, funder0) = {
        let c = lock(state);
        let w = WideCaptureEscrow::read(&c.account(&escrow_addr).unwrap().data, SEASON_ID, dest.world(), f.citizen.to_bytes()).unwrap();
        let funder = Address::new_from_array(w.funder());
        (w.escrow(), funder, c.account(&funder).map(|a| a.lamports).unwrap_or(0))
    };

    // c. the keeper resolves the reservation's bell (not applied, by the program's rule), then settles it
    let mut seen_not_applied = false; // only when a NOT_APPLIED record is actually observed
    let mut resolved_past = false;
    let mut freed = false;
    for _ in 0..400 {
        if t0.elapsed().as_secs() >= deadline {
            break;
        }
        assert!(pilot.tick(state).await, "the keeper halted: {:?}", pilot.keeper.status);
        if let Some(step) = pilot.keeper.status.resident_step.as_deref().filter(|s| s.starts_with("Stopped") || s.starts_with("Unknown")) {
            panic!("t+{:.1}s the resident driver stopped (not resent): {step}", t0.elapsed().as_secs_f32());
        }
        let (rn_now, t) = {
            let c = lock(state);
            (rn_of(&c), table_of(&c))
        };
        if rn_now > bell {
            resolved_past = true;
            assert!(t.entry(site).unwrap().is_none(), "the reservation must NOT become a siege entry");
            if let Some(r) = t.reservations().iter().flatten().find(|r| r.bell == bell) {
                assert_eq!(r.status, RES_NOT_APPLIED, "not applied by the program's rule");
                if !seen_not_applied {
                    eprintln!("t+{:.1}s NOT APPLIED observed at bell {bell}: seq {} done {} (full return owed)", t0.elapsed().as_secs_f32(), r.seq, r.done);
                    let c = lock(state);
                    evidence.push(snapshot(&c, ctx, f, dest, dest_key, site, "not_applied", bell));
                }
                seen_not_applied = true;
            }
        }
        if resolved_past && t.reservations().iter().all(Option::is_none) {
            freed = true;
            break;
        }
        let now = lock(state).unix_timestamp();
        advance(state, now + 200); // SYNTHETIC test-clock step only
    }
    assert!(resolved_past, "bell {bell} not resolved in time: {}", pilot.keeper.status.json());
    assert!(freed, "the keeper's SettleReservation did not complete the full return in time: {}", pilot.keeper.status.json());
    if !seen_not_applied {
        // never inferred from the record's disappearance alone: the separate evidence below
        // (no site entry, empty table, the exact full return, the action-9 receipt) must all hold
        eprintln!("NOT_APPLIED record NOT observed directly (resolve and settlement fell between observations); relying on the separate evidence asserted below");
    }

    // d. the full return, exactly
    let c = lock(state);
    evidence.push(snapshot(&c, ctx, f, dest, dest_key, site, "returned", bell));
    let hd = c.account(&f.holding).unwrap().data;
    let cd = c.account(&f.citizen).unwrap().data;
    let (arms, gold) = provisioned;
    eprintln!("t+{:.1}s RETURNED: source arms {} gold {} (before {:?}, provisioned {:?}); slots byte {:#04x} -> {:#04x}; sieges_today {} -> {}",
        t0.elapsed().as_secs_f32(), store(&hd, ARMS_I).0, store(&hd, GOLD_I).0, stores0, provisioned, cd0[C::SLOTS], cd[C::SLOTS], cd0[C::SIEGES_TODAY], cd[C::SIEGES_TODAY]);
    assert_eq!((store(&hd, ARMS_I).0, store(&hd, GOLD_I).0), (arms, gold), "every collected arms and gold milli returned to the source");
    assert_eq!(cd[C::SIEGES_TODAY], cd0[C::SIEGES_TODAY], "the day's declaration count stays consumed (not restored)");
    assert_eq!(cd0[C::SIEGES_TODAY], 1, "the reservation consumed one count of the day's cap");
    assert_eq!(wc_reserved(cd[C::SLOTS]), 0, "the Citizen's reservation slot mark is cleared");
    let esc1 = c.account(&escrow_addr).unwrap();
    let w = WideCaptureEscrow::read(&esc1.data, SEASON_ID, dest.world(), f.citizen.to_bytes()).unwrap();
    assert_eq!(w.active_mask(), 0, "the escrow binding is refunded");
    // the rent: the ledger's decrease is the expected refund; the escrow lost exactly that and the
    // funder received exactly that (the keeper, not the funder, paid the SettleReservation fee)
    let expected_refund = escrow_ledger0 - w.escrow();
    let funder1 = c.account(&funder).map(|a| a.lamports).unwrap_or(0);
    eprintln!("rent: escrow ledger {escrow_ledger0} -> {} (expected refund {expected_refund}); escrow lamports {} -> {}; funder {funder} lamports {funder0} -> {funder1}",
        w.escrow(), esc0.lamports, esc1.lamports);
    assert!(expected_refund > 0, "a nonzero rent refund is owed");
    assert_eq!(esc0.lamports - esc1.lamports, expected_refund, "the escrow lost exactly the refund");
    assert_eq!(funder1 - funder0, expected_refund, "the funder received exactly the refund");

    // e. the SettleReservation receipts from its own transaction log
    let r = pilot.resident.as_ref().expect("the resident bells driver");
    let line = r.log.iter().rev().find(|l| l.contains("Landed(\"SettleReservation")).cloned()
        .unwrap_or_else(|| panic!("no landed SettleReservation in the keeper log: {:?}", r.log.iter().rev().take(5).collect::<Vec<_>>()));
    let sig_str = line.rsplit('"').nth(1).expect("the signature").to_string();
    let rsig = sig_str.parse().expect("a signature");
    let l = c.transaction(&rsig).expect("the landed SettleReservation");
    assert!(l.err.is_none());
    assert_ne!(l.keys[0], funder, "the SettleReservation fee payer is not the funder, so the funder's increase is the refund alone");
    let rs = conquest_receipts(ctx, &l.logs);
    eprintln!("RECEIPTS of the SettleReservation tx {sig_str}: {rs:?}");
    let refund = frontier_abi::world_index::event::conquest::RESERVATION_REFUND;
    assert!(rs.iter().any(|r| r.0 == "PSW1" && r.1 == "ConquestSettled" && r.2 == refund), "ConquestSettled with action 9 (RESERVATION_REFUND)");
    assert!(rs.iter().any(|r| r.2 == refund && (r.1 == "ConquestCredited" || r.1 == "LegacySourceCredit")), "the source credit record carries action 9");
}
fn wc_reserved(slots: u8) -> u8 {
    frontier_abi::world_index::conquest::wide_reservations(slots).unwrap()
}

/// A pinned binary: the path from `var`, its sha256 must equal `${var}_SHA256` (re-hashed now).
fn pinned_bin(var: &str) -> String {
    let path = std::env::var(var).unwrap_or_else(|_| panic!("{var} (absolute path of the binary) is required"));
    let want = std::env::var(format!("{var}_SHA256")).unwrap_or_else(|_| panic!("{var}_SHA256 is required"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let got = hex_of(&permutation_rules::hash::sha256(&[&bytes]));
    assert_eq!(got, want, "{var}: {path} does not match its pinned sha256");
    path
}
fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
/// One CLI run: args, stdin JSON, its single stdout JSON line (the CLIs bound themselves to 25 s). The exit
/// status is returned beside the report and recorded in the evidence.
fn run_cli(bin: &str, args: &[&str], stdin: &[u8]) -> (serde_json::Value, Option<i32>) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(bin).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap_or_else(|e| panic!("spawn {bin}: {e}"));
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let v = serde_json::from_str(text.trim()).unwrap_or_else(|e| panic!("{bin}: not one JSON line ({e}): {text} / stderr {}", String::from_utf8_lossy(&out.stderr)));
    (v, out.status.code())
}

/// V2: the preview CLI, then the conquest prepare CLI with the relay's pins, against this harness's RPC; the
/// CLI's message is byte-compared with the builder's rebuilt from the CLI's own blockhash observation, then
/// signed by the in-memory key. Returns the wire and both reports (for the evidence file).
#[allow(clippy::too_many_arguments)]
fn cli_route_wire(state: &localnet::server::Shared, ctx: &AddrCtx, f: &crate::expedition_play::Fixture, player: &Keypair, dest: ProvinceKey,
    site: u8, entry: u8, url: &str) -> (Vec<u8>, serde_json::Value) {
    use base64::Engine as _;
    use fclient::experimental_expedition_message::{prepare_conquest_declare, Target, CONQUEST_DECLARE_HEAP_FRAME};
    use fclient::tx::{self, TxBudget};
    use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
    use frontier_abi::v2::layout::world::season as S;
    let preview_bin = pinned_bin("WYLLS_PREVIEW_CLI");
    let prepare_bin = pinned_bin("WYLLS_CONQUEST_PREPARE_CLI");
    let (ruleset, slot) = {
        let c = lock(state);
        let sd = c.account(&f.season).unwrap().data;
        (hex_of(&sd[S::RULESET_HASH..S::RULESET_HASH + 32]), c.slot())
    };
    let program = Address::new_from_array(PROGRAM).to_string();
    let season = f.season.to_string();
    let wallet = player.pubkey().to_string();
    let preview_req = serde_json::json!({"schema": "frontier-original-expedition-request-v1", "operation": "inspect", "cluster": "localnet",
        "program": program, "season": season, "deployment": {"program_version": PROGRAM_VERSION.to_string(), "ruleset_hash": ruleset},
        "host": hex_of(&f.host.to_bytes()), "original_owner": f.citizen.to_string(),
        "standing": {"p": dest.coord().p().to_string(), "q": dest.coord().q().to_string()},
        "min_slot": slot.to_string(), "wallet": wallet, "payer": wallet});
    let (preview, preview_exit) = run_cli(&preview_bin, &["--rpc-url", url], &serde_json::to_vec(&preview_req).unwrap());
    eprintln!("PREVIEW CLI: exit {preview_exit:?} status {} source {}", preview["status"], preview["source"]);
    assert_eq!(preview_exit, Some(0), "the preview CLI exits successfully: {preview}");
    assert_eq!(preview["status"], "preview", "the preview CLI inspects the host: {preview}");
    // P2: the exact observation fields the prepare CLI itself requires (wideexpedition::plan(..).describe())
    let facts = &preview["facts"];
    eprintln!("P2: observed {} next_prerequisite {}", facts["observed"], facts["next_prerequisite"]);
    assert_eq!(facts["observed"]["kind"], "original-host-wide-resident", "P2: observation kind: {preview}");
    assert_eq!(facts["observed"]["state"], 1, "P2: the host's entry state is roster (1): {preview}");
    assert_eq!(facts["observed"]["entry"].as_u64(), Some(u64::from(entry)), "P2: the observed entry is the one the declaration names");
    assert_eq!(facts["next_prerequisite"], "OwnerDissolve", "P2: next prerequisite: {preview}");
    let request = serde_json::json!({"schema": "frontier-local-play-conquest-prepare-request-v1", "request_id": "v2-route-run",
        "action": "DeclareSiege", "source_request": preview_req, "source_context_slot": preview["source"]["context_slot"],
        "source_snapshot_digest": preview["source"]["digest"], "target": {"site": site, "entry": entry}});
    // the budget the real launcher passes to the relay (local-play-launcher.mjs:459), unless overridden (recorded)
    let cu: u32 = std::env::var("WYLLS_V2_CU_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(1_000_000);
    let loaded: u32 = std::env::var("WYLLS_V2_LOADED_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(67_108_864);
    let (cu_s, loaded_s) = (cu.to_string(), loaded.to_string());
    eprintln!("V2 budget passed to the CLI: cu_limit {cu}, loaded_limit {loaded}");
    let args = ["--rpc-url", url, "--program", program.as_str(), "--season", season.as_str(), "--fee-payer", wallet.as_str(),
        "--ruleset-hash", ruleset.as_str(), "--cu-limit", cu_s.as_str(), "--loaded-limit", loaded_s.as_str()];
    let (report, prepare_exit) = run_cli(&prepare_bin, &args, &serde_json::to_vec(&request).unwrap());
    eprintln!("PREPARE CLI: exit {prepare_exit:?} status {} blocker {} dispatch {} budget {}", report["status"], report["blocker"], report["prepared"]["dispatch"], report["prepared"]["budget"]);
    assert_eq!(prepare_exit, Some(0), "the prepare CLI exits 0 only for status prepared: {report}");
    assert_eq!(report["status"], "prepared", "H2: the CLI prepares on this reservation-capable chain (blocker {}); not worked around", report["blocker"]);
    let p = &report["prepared"];
    assert_eq!((p["dispatch"]["tag"].as_u64(), p["dispatch"]["kind"].as_u64()), (Some(0xDA), Some(12)), "kind 12 under tag 0xDA");
    assert_eq!((p["budget"]["cu_limit"].as_u64(), p["budget"]["loaded_limit"].as_u64(), p["budget"]["heap"].as_u64()),
        (Some(cu as u64), Some(loaded as u64), Some(CONQUEST_DECLARE_HEAP_FRAME as u64)), "the budget passed to the CLI and the 256 KiB frame");
    let cli_msg = base64::engine::general_purpose::STANDARD.decode(p["message_b64"].as_str().unwrap()).unwrap();
    // the builder's message from the CLI's own observation and pins: must be byte-identical (H1)
    let bh = &report["blockhash"];
    let num = |k: &str| bh[k].as_str().unwrap().parse::<u64>().unwrap();
    let hash: fclient::Hash = bh["hash"].as_str().unwrap().parse().unwrap();
    let obs = BlockhashObservation { blockhash: hash.to_bytes(), context_slot: num("validity_context_slot"), valid: true,
        block_height: num("block_height"), last_valid_block_height: num("last_valid_block_height") };
    let budget = TxBudget { cu_limit: cu, cu_price: 0, loaded_limit: loaded, heap: Some(CONQUEST_DECLARE_HEAP_FRAME) };
    let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
    let draft = fclient::wide_conquest_draft::Draft::declare_siege(ctx, f.host, dest, site, entry, player.pubkey()).unwrap();
    let prepared = prepare_conquest_declare(&draft, Target { program: Address::new_from_array(PROGRAM), season: f.season, program_version: PROGRAM_VERSION },
        obs, budget, limits).unwrap();
    let mine = prepared.message_bytes().unwrap();
    assert_eq!(mine, cli_msg, "H1: the CLI's message bytes equal the builder's from the same observation and pins");
    eprintln!("H1: CLI message {} bytes, digest {}, byte-identical to the builder's", cli_msg.len(), p["message_digest"]);
    // the chain's own loaded-accounts size of THIS message (accounts + base + ProgramData), before any send
    let (loaded_size, program_len, snap) = {
        let c = lock(state);
        let dest_key = Address::new_from_array(province_address(ctx, dest.coord()));
        // the bell recorded is the chain clock's current bell at this read (never a placeholder)
        let now_bell = fclient::decode::Season::decode(&c.account(&f.season).unwrap().data).ok()
            .and_then(|s| fclient::clock::SeasonClock::from_season(&s).bell_at(c.unix_timestamp()))
            .expect("the current bell from the chain's own clock");
        (c.loaded_size(prepared.message()), c.account(&Address::new_from_array(PROGRAM)).map(|a| a.data.len()),
            snapshot(&c, ctx, f, dest, &dest_key, site, "cli_prepared_before_send", now_bell))
    };
    eprintln!("LOADED SIZE of the CLI message on this chain: {loaded_size} bytes (program account data {program_len:?}); budget loaded_limit {loaded}");
    if let Ok(path) = std::env::var("WYLLS_REAL_EVIDENCE") {
        let early = serde_json::json!({"schema": "claude-conquest-v2-cli-prepared-evidence-v1",
            "synthetic": "memory-only test chain; SYNTHETIC initial state; not natural play; written BEFORE simulate/send",
            "budget": {"cu_limit": cu, "loaded_limit": loaded, "heap": CONQUEST_DECLARE_HEAP_FRAME},
            "loaded_size_measured": loaded_size, "program_account_data_len": program_len,
            "message_b64": p["message_b64"], "message_digest": p["message_digest"], "byte_identical_to_builder": true,
            "preview_cli": {"path": preview_bin, "sha256": std::env::var("WYLLS_PREVIEW_CLI_SHA256").unwrap(), "exit": preview_exit, "report": preview},
            "prepare_cli": {"path": prepare_bin, "sha256": std::env::var("WYLLS_CONQUEST_PREPARE_CLI_SHA256").unwrap(), "exit": prepare_exit, "report": report},
            "snapshot": snap});
        let early_path = format!("{path}.cli-prepared.json");
        std::fs::write(&early_path, serde_json::to_vec_pretty(&early).unwrap()).expect("write the early V2 evidence");
        eprintln!("EVIDENCE (before send) written: {early_path}");
    }
    let wire = tx::wire(&tx::sign(prepared.message().clone(), &[player]).unwrap());
    let reports = serde_json::json!({"preview_cli": {"path": preview_bin, "sha256": std::env::var("WYLLS_PREVIEW_CLI_SHA256").unwrap(), "exit": preview_exit, "report": preview},
        "prepare_cli": {"path": prepare_bin, "sha256": std::env::var("WYLLS_CONQUEST_PREPARE_CLI_SHA256").unwrap(), "exit": prepare_exit, "report": report},
        "message_b64": p["message_b64"], "byte_identical_to_builder": true,
        "budget": {"cu_limit": cu, "loaded_limit": loaded}, "loaded_size_measured": loaded_size,
        "signed_message": "the CLI's bytes, byte-identical to the builder's rebuilt from the CLI's own observation and pins, signed by the in-memory key",
        "not_shown_here": "the gateway and page validators on these bytes: Fable's separate Node verification"});
    (wire, reports)
}

/// H3 synthetic branch (see the test's doc). Every synthetic write is logged; nothing is resolved afterwards.
#[allow(clippy::too_many_arguments)]
fn h3_immediate(state: &localnet::server::Shared, ctx: &AddrCtx, f: &crate::expedition_play::Fixture, player: &Keypair, dest: ProvinceKey,
    dest_key: &Address, site: u8, clock: &fclient::clock::SeasonClock, t0: std::time::Instant) {
    use fclient::experimental_expedition_message::{prepare_conquest_declare, Target, CONQUEST_DECLARE_HEAP_FRAME};
    use fclient::tx::{self, TxBudget};
    use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
    use frontier_abi::entry::{read_entry, write_entry, Entry, EntryOp};
    use frontier_abi::layout::province::{entry as E, province as PL};
    use frontier_abi::world_index::conquest::{conquest_address, WideConquest};
    use frontier_abi::world_index::roster::{roster_address, WideRoster};
    use frontier_abi::world_index::WideHostRef;
    let rn_off = frontier_abi::v2::layout::province::province::RESOLVED_NEXT;
    let roster_key = Address::new_from_array(roster_address(ctx, dest));
    // a. SYNTHETIC: current-bell cursor and a full roster (logged)
    let (now_bell, entry, filled, rn_before, live) = {
        let mut c = lock(state);
        let now_bell = clock.bell_at(c.unix_timestamp()).unwrap();
        let mut pa = c.account(dest_key).unwrap();
        let mut ra = c.account(&roster_key).unwrap();
        let roster = WideRoster::read(&ra.data).unwrap();
        let rn_before = u32::from_le_bytes(pa.data[rn_off..rn_off + 4].try_into().unwrap());
        let tile = pa.data[frontier_abi::v2::layout::province::province::SITES + site as usize];
        // the player's own host on the city's tile
        let residents = crate::resident_bells::residents_of(&c, &fclient::addr::Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID), dest, &pa.data, &f.holding).unwrap();
        let (entry, _, _) = residents.first().copied().expect("the host stays at the Free City's province");
        let mine = read_entry(&pa.data, entry as usize).unwrap();
        let other_faction = (mine.faction + 1) % 6;
        let other_tile = if tile == 0 { 1 } else { tile - 1 };
        let mut filled = 0usize;
        for i in 0..PL::ENTRIES_N {
            if read_entry(&pa.data, i).unwrap().state != E::STATE_FREE {
                continue;
            }
            let host = WideHostRef::new(dest, ((i % 11) as u8 + 2) % 12, 1, 10_000 + i as u32).unwrap();
            let alias = roster.claim(&mut ra.data, i, &host).unwrap();
            write_entry(&mut pa.data, i, &Entry { id: alias, faction: other_faction, unit: 2, tile: other_tile, state: E::STATE_ROSTER,
                troops: 1_000, stamina_value: permutation_rules::frontier::host::STAMINA_CAP, op: EntryOp::None, ..Entry::FREE }).unwrap();
            filled += 1;
        }
        let live = (0..PL::ENTRIES_N).filter(|i| read_entry(&pa.data, *i).unwrap().state != E::STATE_FREE).count();
        pa.data[PL::N_ENTRIES] = live as u8;
        pa.data[rn_off..rn_off + 4].copy_from_slice(&now_bell.to_le_bytes());
        c.set_account(*dest_key, pa).unwrap();
        c.set_account(roster_key, ra).unwrap();
        eprintln!("SYNTHETIC H3: destination RESOLVED_NEXT {rn_before} -> {now_bell} (current bell); roster filled with {filled} synthetic hosts (faction {other_faction}, tile {other_tile}); live entries {live} of {}", PL::ENTRIES_N);
        let pd = c.account(dest_key).unwrap().data;
        let rd = c.account(&roster_key).unwrap().data;
        let table = WideRoster::read(&rd).unwrap().table(&rd).unwrap();
        assert_eq!(table.len(), PL::ENTRIES_N, "the lead check's roster table is at its maximum");
        let lead = frontier_abi::world_index::resolve::siege_lead(&pd, &WideRoster::read(&rd).unwrap(), &rd, tile, mine.faction, now_bell).unwrap();
        assert_eq!(lead.map(|(i, _)| i), Some(entry as usize), "the player's host still leads its faction on the city's tile");
        (now_bell, entry as u8, filled, rn_before, live)
    };
    // b. the player's immediate DeclareSiege: launcher budget, 256 KiB heap
    let draft = fclient::wide_conquest_draft::Draft::declare_siege(ctx, f.host, dest, site, entry, player.pubkey()).unwrap();
    let (wire, loaded_size) = {
        let c = lock(state);
        let (blockhash, last_valid) = c.latest_blockhash();
        let obs = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100),
            last_valid_block_height: last_valid };
        let budget = TxBudget { cu_limit: 1_000_000, cu_price: 0, loaded_limit: 67_108_864, heap: Some(CONQUEST_DECLARE_HEAP_FRAME) };
        let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
        let prepared = prepare_conquest_declare(&draft, Target { program: Address::new_from_array(PROGRAM), season: f.season, program_version: PROGRAM_VERSION },
            obs, budget, limits).unwrap();
        (tx::wire(&tx::sign(prepared.message().clone(), &[player]).unwrap()), c.loaded_size(prepared.message()))
    };
    let sim = lock(state).simulate(&wire, true).unwrap();
    eprintln!("H3 immediate DeclareSiege at bell {now_bell} (cursor {now_bell}, {filled} synthetic hosts): err {:?} code {:?}, {} CU; loaded size {loaded_size}", sim.err, sim.code, sim.units);
    for l in &sim.logs {
        eprintln!("  {l}");
    }
    assert!(sim.err.is_none(), "the immediate path with a full roster runs within the 256 KiB frame (code {:?})", sim.code);
    let sig = lock(state).submit(&wire).expect("submitted");
    let mut landed = false;
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(l) = lock(state).transaction(&sig) {
            assert!(l.err.is_none(), "the immediate declaration failed: {:?}", l.err);
            landed = true;
            break;
        }
    }
    assert!(landed, "the immediate declaration did not land (outcome unknown; not resent)");
    // c. it took the IMMEDIATE path: DECLARE receipt, site entry at once, no reservation record
    let c = lock(state);
    let l = c.transaction(&sig).unwrap();
    let rs = conquest_receipts(ctx, &l.logs);
    eprintln!("t+{:.1}s RECEIPTS of the immediate declaration {sig}: {rs:?}", t0.elapsed().as_secs_f32());
    let declare = frontier_abi::world_index::event::conquest::DECLARE;
    assert!(rs.iter().any(|r| r.0 == "PSW1" && r.1 == "ConquestDeclared" && r.2 == declare && r.3 == now_bell), "ConquestDeclared action 1 (DECLARE) at bell {now_bell}");
    let t = WideConquest::read(&c.account(&Address::new_from_array(conquest_address(ctx, dest))).unwrap().data, SEASON_ID, dest).unwrap();
    let e = t.entry(site).unwrap().expect("the site entry is written at once");
    assert_eq!(e.declaration_bell, now_bell);
    assert!(t.reservations().iter().all(Option::is_none), "no reservation record on the immediate path");
    eprintln!("H3 IMMEDIATE PATH LANDED: entry kind {} required {} declaration_bell {}; SYNTHETIC cursor and roster; not natural play", e.rules.kind, e.rules.required, e.declaration_bell);
    // d. public evidence (no key): the synthetic writes, the receipts, the measured CU / loaded size, a 4-account snapshot
    if let Ok(path) = std::env::var("WYLLS_REAL_EVIDENCE") {
        let doc = serde_json::json!({"schema": "claude-conquest-h3-synthetic-immediate-evidence-v1",
            "synthetic": "memory-only test chain; SYNTHETIC current-bell cursor and SYNTHETIC roster fill written by the test; strong fixture; NOT natural play; a heap check of the immediate branch only; heapConfirmed/pageBinding untouched",
            "artifact_sha256": std::env::var("WYLLS_CONQUEST_SBF_SHA256").unwrap_or_default(),
            "synthetic_writes": {"resolved_next_before": rn_before, "resolved_next_after": now_bell, "roster_hosts_added": filled,
                "live_entries": live, "entries_capacity": PL::ENTRIES_N},
            "transaction": {"signature": sig.to_string(), "budget": {"cu_limit": 1_000_000, "loaded_limit": 67_108_864, "heap": CONQUEST_DECLARE_HEAP_FRAME},
                "simulated_cu": sim.units, "loaded_size_measured": loaded_size, "receipts": rs},
            "result": {"path": "immediate", "receipt_action": declare, "site_entry_declaration_bell": e.declaration_bell, "site_entry_kind": e.rules.kind,
                "reservation_records": 0},
            "snapshot_after": snapshot(&c, ctx, f, dest, dest_key, site, "h3_immediate_after", now_bell)});
        std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap()).expect("write the H3 evidence");
        eprintln!("EVIDENCE written: {path}");
    }
}
