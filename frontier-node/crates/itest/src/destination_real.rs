//! TEST ONLY (ignored): the real-SBF evidence of one wide arrival at (129, 0)
//! carried through the PRODUCTION destination driver (unchanged), on an
//! isolated in-memory runner chain. This is not a browser play-through: no
//! browser, relay or user world is involved, and nothing here is evidence of
//! the browser's Reveal.
//!
//! What is REAL (the deployed SBF artifact executes each instruction):
//! - WideConsumeRingSeed, WideSetRules and WideOpenProvince of (129, 0)
//!   (`wide_destination::run`);
//! - the player's signed Depart (`origin_driver::real_origin`'s fixture);
//! - the origin driver's GatherClash, PostSeed, ResolveFromInputs and
//!   SettleOrigin, and the keeper's PostAnchor with public Quicknet rounds;
//! - the ExpeditionReveal (version-2 dispatch, the REVEAL account order of
//!   `wide_ix::REVEAL`, built here from the player's own seal);
//! - the destination driver's PostAnchor, ExpeditionGather, PostSeed,
//!   Resolve (quiet catch-up bells included) and SettleMember.
//!
//! What is SYNTHETIC (stated, never claimed as gameplay):
//! - the initial fixture of `launch_full`: the Season, Frontier, ring-128
//!   RingSeed (zero seed), Citizen, Holding and site mirror written with
//!   `Chain::set_account`; the requested ring-129 WideRingSeed record and the
//!   Season's in-memory test authority (`wide_destination::synthetic_note`);
//! - the time: this chain's clock starts at a past date (`Config::g0`, so the
//!   public rounds exist) and is moved forward with the node's own scale
//!   control (this test chain only): once to the bound round of the ring
//!   seed, then in 120-second steps between ticks.
//!
//! Secrets: the player's seal and plaintext stay in memory; nothing secret is
//! printed (only instruction names and public signatures). Needs the
//! artifact (`WYLLS_EXPEDITION_SBF`, `WYLLS_EXPEDITION_SBF_SHA256`) and
//! `WYLLS_PUBLIC_DRAND=1` (it reads the public drand API).
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::{archive_part_of, day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{arrival_day_address, arrival_slot_address, clash_inputs_address, wide_clash_inputs, WideClashInputsHdr},
    expedition::AccountResolver,
    expedition_dispatch_ix::{self as dx, Kind},
    expedition_transport::OwnedBridgeTransit,
    land::{province_address, WideProvince},
    march::transit_address,
    tiles::WideTile,
    wide_ix as wix, ProvinceKey, TileAddress, WideCoord,
};
use localnet::server::{self, lock, Shared};

use crate::expedition_play::{inspect, launch_full, PROGRAM, REFUSED_PORT, SEASON_ID};
use crate::keeper_loop::{public_quicknet, submit_and_wait, Pilot, Sent, LAND_TIMEOUT};
use crate::local_keeper as lk;
use crate::origin_driver::real_origin::real_depart_routed;

pub(crate) fn keep_rx() -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    std::mem::forget(tx);
    rx
}
fn artifact() -> crate::expedition_play::Artifact {
    let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
    let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
    inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap()
}
pub(crate) fn ports(from: u16) -> (u16, u16) {
    let p = (from..from + 7).find(|p| *p != REFUSED_PORT && server::check_port(*p).is_ok()).unwrap();
    (p, (p + 1..from + 8).find(|x| server::check_port(*x).is_ok()).unwrap())
}
/// The advance scale: one block = `SLOT_MS × scale` = 10 game seconds.
const ADVANCE_SCALE: f64 = 25.0;
const ADVANCE_BLOCK_SECS: i64 = localnet::chain::SLOT_MS as i64 * ADVANCE_SCALE as i64 / 1_000;
/// The longest single advance (and so the most blocks one call produces).
const MAX_ADVANCE_SECS: i64 = 2 * 3_600;

/// SYNTHETIC time (this test chain only): the node's own scale control, in
/// 10-second blocks, bounded, then restored; the overshoot past `to_unix`
/// is checked to be under one block (plus the restoring 0.4 s block), so a
/// 120-second step never jumps a reveal window.
pub(crate) fn advance(state: &Shared, to_unix: i64) {
    let mut c = lock(state);
    let from = c.unix_timestamp();
    assert!(to_unix - from <= MAX_ADVANCE_SECS, "an advance of {}s is past the bound", to_unix - from);
    let restore = c.scale();
    c.set_scale(ADVANCE_SCALE);
    let mut blocks = 0;
    while c.unix_timestamp() < to_unix {
        c.produce_block();
        blocks += 1;
        assert!(blocks <= MAX_ADVANCE_SECS / ADVANCE_BLOCK_SECS + 1, "advance block bound");
    }
    c.set_scale(restore);
    c.produce_block();
    let over = c.unix_timestamp() - to_unix.max(from);
    assert!(over <= ADVANCE_BLOCK_SECS + 1, "advance overshoot {over}s");
}

/// A derived route (pure over the generated province masks): the hex
/// directions, the destination tile, the provinces in `path_tiles` order
/// (destination first, then each first-entered other province) and the
/// stepped tiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub(crate) dirs: Vec<u8>,
    pub(crate) dest_tile: u8,
    pub(crate) keys: Vec<ProvinceKey>,
    pub(crate) steps: Vec<TileAddress>,
}

/// The program's masks of one province (`PASSABLE`, `ROUGH`, `ROAD`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Masks {
    key: ProvinceKey,
    passable: u64,
    rough: u64,
    road: u64,
}

pub(crate) fn masks_of(key: ProvinceKey, data: &[u8]) -> Masks {
    use frontier_abi::v2::layout::province::province as PV;
    let u = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Masks { key, passable: u(PV::PASSABLE_MASK), rough: u(PV::ROUGH_MASK), road: u(PV::ROAD_MASK) }
}

/// The shortest route from `origin` into any passable tile of `dest`, stepping
/// only on passable tiles of the provinces in `lands` (the program's
/// `path_tiles` geometry: `WideTile::neighbors` in `DIRECTIONS` order), at
/// most `MAX_PATH_STEPS` steps and `MAX_PATH_PROVINCES` provinces. Watch
/// blocks of structures are not modelled here (the Reveal checks them).
pub(crate) fn derive_route(origin: TileAddress, dest: ProvinceKey, lands: &[Masks]) -> Option<Route> {
    derive_route_to(origin, dest, lands, None)
}

/// As [`derive_route`], ending on `tile` of `dest` when given (e.g. the Free
/// City's tile the program placed), else on any passable tile of `dest`.
pub(crate) fn derive_route_to(origin: TileAddress, dest: ProvinceKey, lands: &[Masks], tile: Option<u8>) -> Option<Route> {
    use permutation_rules::frontier::travel::{MAX_PATH_PROVINCES, MAX_PATH_STEPS};
    let passable = |t: &WideTile| lands.iter().any(|l| l.key == t.province() && l.passable & (1u64 << t.local()) != 0);
    let start = WideTile::of(origin);
    let mut prev: std::collections::HashMap<WideTile, (WideTile, u8)> = Default::default();
    let mut frontier = std::collections::VecDeque::from([(start, 0usize)]);
    let mut goal = None;
    while let Some((t, depth)) = frontier.pop_front() {
        if t != start && t.province() == dest && tile.is_none_or(|x| x == t.local()) {
            goal = Some(t);
            break;
        }
        if depth == MAX_PATH_STEPS {
            continue;
        }
        for (dir, n) in t.neighbors().iter().enumerate() {
            let Some(n) = n else { continue };
            if *n == start || prev.contains_key(n) || !passable(n) {
                continue;
            }
            prev.insert(*n, (t, dir as u8));
            frontier.push_back((*n, depth + 1));
        }
    }
    let mut t = goal?;
    let mut dirs = vec![];
    let mut tiles = vec![];
    while t != start {
        let (p, d) = prev[&t];
        dirs.push(d);
        tiles.push(t);
        t = p;
    }
    dirs.reverse();
    tiles.reverse();
    let mut keys = vec![dest];
    for s in &tiles {
        if !keys.contains(&s.province()) {
            keys.push(s.province());
        }
    }
    if keys.len() > MAX_PATH_PROVINCES {
        return None;
    }
    Some(Route { dest_tile: tiles.last()?.local(), dirs, keys, steps: tiles.iter().map(|s| s.address()).collect() })
}

/// The program's raw walking seconds of `steps` (`walk`: rough 180 / flat
/// 120, halved for cavalry and again on a road).
pub(crate) fn raw_secs(steps: &[TileAddress], lands: &[Masks], cavalry: bool) -> u32 {
    use permutation_rules::frontier::travel::{FLAT_HEX_SECS, ROUGH_HEX_SECS};
    steps.iter().map(|s| {
        let l = lands.iter().find(|l| l.key == s.key()).expect("a stepped province");
        let bit = 1u64 << s.local();
        let base = if l.rough & bit != 0 { ROUGH_HEX_SECS } else { FLAT_HEX_SECS };
        base >> (cavalry as u32 + (l.road & bit != 0) as u32)
    }).sum()
}

/// An upper bound of the travel seconds for any faction and unit (slowest:
/// no cavalry, no road), so the chosen arrival bell is never too early.
pub(crate) fn travel_upper(steps: &[TileAddress], lands: &[Masks]) -> u32 {
    let flat_or_rough: u32 = steps.iter().map(|s| {
        let l = lands.iter().find(|l| l.key == s.key()).expect("a stepped province");
        if l.rough & (1u64 << s.local()) != 0 { permutation_rules::frontier::travel::ROUGH_HEX_SECS } else { permutation_rules::frontier::travel::FLAT_HEX_SECS }
    }).sum();
    (0..6u8).filter_map(permutation_rules::frontier::doctrine::of_faction_v3).map(|d| d.travel_secs(flat_or_rough as u64) as u32).max().expect("a doctrine")
}

/// The player's ExpeditionReveal (version-2 dispatch, `Kind::Reveal`) of
/// `holding`'s transit `slot` into ArrivalSlot position `target`: the
/// sixteen accounts of `wide_ix::REVEAL` in order, then the route's path
/// provinces (`route.keys` after the destination, read-only, at their
/// family's canonical address); writable exactly the payer, the day and the
/// target slot.
#[allow(clippy::too_many_arguments)]
pub(crate) fn reveal_ix(ctx: &AddrCtx, payer: &Address, holding: &Address, slot: u8, faction: u8, arrive: u32, region: u8, dest: ProvinceKey,
    sealed: &fclient::wide_seal::WideSealed, target: u8, route: &Route) -> Instruction {
    let inner = wix::ExpeditionReveal { transit_slot: slot, target_i: target, plain: *sealed.reveal.plain(), salt: *sealed.reveal.salt(),
        ct_hash: sealed.ct_hash, beneficiary: payer.to_bytes() };
    let data = dx::encode(Kind::Reveal, &inner.to_bytes()).expect("a Reveal wire");
    let a = |k: [u8; 32]| Address::new_from_array(k);
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a(ctx.season), false),
        AccountMeta::new_readonly(*holding, false),
        AccountMeta::new_readonly(a(transit_address(ctx, &holding.to_bytes(), slot)), false),
        AccountMeta::new_readonly(a(ctx.bell_anchor(arrive, region)), false),
        AccountMeta::new_readonly(a(ctx.anchor_archive(region, archive_part_of(arrive))), false),
        AccountMeta::new_readonly(a(ctx.beacon_log(region)), false),
        AccountMeta::new_readonly(a(clash_inputs_address(ctx, dest, arrive)), false),
        AccountMeta::new_readonly(a(province_address(ctx, dest.coord())), false),
        AccountMeta::new(a(arrival_day_address(ctx, dest, day_of(arrive))), false),
    ];
    for i in 0..4u8 {
        let k = a(arrival_slot_address(ctx, dest, arrive, faction, i));
        m.push(if i == target { AccountMeta::new(k, false) } else { AccountMeta::new_readonly(k, false) });
    }
    m.push(AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false));
    m.push(AccountMeta::new_readonly(fclient::addr::system_program(), false));
    assert_eq!(m.len(), wix::REVEAL_FIXED);
    assert_eq!(route.keys.first(), Some(&dest), "the route's first province is the destination");
    let resolver = AccountResolver::for_season(ctx).expect("a resolver");
    for k in &route.keys[1..] {
        m.push(AccountMeta::new_readonly(a(resolver.province_address(*k).expect("a path province address")), false));
    }
    Instruction { program_id: a(PROGRAM), accounts: m, data }
}

#[test]
fn the_test_reveal_has_the_reveal_tables_shape() {
    // pure: the order reveal_ix uses is the abi's REVEAL table positions
    let n = wix::REVEAL_FIXED;
    let pos = |name: &str, nth: usize| frontier_abi::prologue::position_in(wix::REVEAL, n, name, nth).unwrap();
    assert_eq!((pos("fee_payer", 0), pos("season", 0), pos("holding", 0), pos("transit", 0)), (0, 1, 2, 3));
    assert_eq!((pos("anchor", 0), pos("archive", 0), pos("beaconlog", 0), pos("inputs", 0), pos("dest_province", 0)), (4, 5, 6, 7, 8));
    assert_eq!((pos("arrivalday", 0), pos("slot", 0), pos("slot", 3)), (wix::REVEAL_DAY, wix::REVEAL_SLOT0, wix::REVEAL_SLOT0 + 3));
    assert_eq!((pos("arrivalday", 0), pos("slot", 0)), (9, 10));
}

#[test]
fn a_derived_route_replays_through_the_programs_geometry() {
    // pure, over hand-made masks (not the generated terrain): the route the
    // test seals is the one `path_tiles` would walk
    let ctx = AddrCtx { program: PROGRAM, season: [3; 32] };
    let world = frontier_abi::world_index::WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
    let home = ProvinceKey::new(world, WideCoord::checked(128, 0).unwrap());
    let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let all = |key| Masks { key, passable: (1u64 << 61) - 1, rough: 0, road: 0 };
    let origin = TileAddress::new(home, 0).unwrap();
    let r = derive_route(origin, dest, &[all(dest), all(home)]).expect("a route over open land");
    assert_eq!(r.keys[0], dest);
    assert!(!r.dirs.is_empty() && r.dirs.len() <= permutation_rules::frontier::travel::MAX_PATH_STEPS);
    let mut t = WideTile::of(origin);
    for (d, s) in r.dirs.iter().zip(&r.steps) {
        t = t.neighbors()[*d as usize].unwrap();
        assert_eq!(t.address(), *s);
    }
    assert_eq!((t.province(), t.local()), (dest, r.dest_tile), "it ends on the destination tile");
    assert_eq!(raw_secs(&r.steps, &[all(dest), all(home)], false), 120 * r.dirs.len() as u32);
    assert!(travel_upper(&r.steps, &[all(dest), all(home)]) > 0);
    // a destination with no passable tile has no route; a blocked home tile is avoided
    assert_eq!(derive_route(origin, dest, &[Masks { passable: 0, ..all(dest) }, all(home)]), None);
    if let Some(first) = r.steps.first().filter(|s| s.key() == home) {
        let blocked = Masks { passable: all(home).passable & !(1u64 << first.local()), ..all(home) };
        if let Some(r2) = derive_route(origin, dest, &[all(dest), blocked]) {
            assert!(!r2.steps.contains(first));
        }
    }
}

/// Real artifact + public drand (module doc): (129, 0) opened by the real
/// instructions, a real Depart and Reveal of the player, then ONLY pilot
/// ticks; the production destination driver must land the member
/// settlement of THIS arrival. Any refusal, unknown outcome or unsupported
/// fate fails the test with its reason (never counted as an arrival).
#[test]
#[ignore]
fn a_real_reveal_at_129_is_gathered_seeded_resolved_and_member_settled() {
    assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
    let art = artifact();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (p, q) = ports(41_930);
        let player = Keypair::new();
        let mut play = launch_full(&art, player.pubkey(), p, q, false, true).await.unwrap();
        let state = play.running.state.clone();
        // 1. (129, 0): the real Consume / SetRules / WideOpenProvince (synthetic
        //    requested seed and test authority: launch_full's, stated there)
        let plan = play.wide.take().expect("launched with the wide destination");
        let f = &play.fixture;
        let ctx = AddrCtx { program: PROGRAM, season: f.season.to_bytes() };
        let round_time = {
            let c = lock(&state);
            let s = fclient::decode::Season::decode(&c.account(&f.season).unwrap().data).unwrap();
            fclient::clock::SeasonClock::from_season(&s).drand.round_time(plan.round)
        };
        advance(&state, round_time + 1); // SYNTHETIC time: to the bound round
        let opened = crate::wide_destination::run(state.clone(), plan, keep_rx(), |_| {}).await.expect("129 opened by the real instructions");
        let region = opened["province"]["region"].as_u64().unwrap() as u8;
        let dest = ProvinceKey::new(f.host.key().world(), WideCoord::checked(129, 0).unwrap());
        let dest_key = Address::new_from_array(province_address(&ctx, dest.coord()));
        let opened_rn = {
            let c = lock(&state);
            let prov = WideProvince::read(&c.account(&dest_key).unwrap().data).unwrap();
            assert_eq!(prov.region, region);
            u32::from_le_bytes(c.account(&dest_key).unwrap().data[frontier_abi::v2::layout::province::province::RESOLVED_NEXT..][..4].try_into().unwrap())
        };

        // 2. a route derived from the GENERATED origin tile (the Holding's site
        //    tile of the real OpenProvince home) to a passable tile of the
        //    GENERATED (129, 0), over the program's own masks
        let (origin, lands) = {
            use frontier_abi::v2::layout::player::holding as H;
            let c = lock(&state);
            let hd = c.account(&f.holding).unwrap().data;
            let home = c.account(&f.home).unwrap().data;
            let pv = fclient::decode::Province::decode(&home).unwrap();
            let (site, tile) = (hd[H::SITE], hd[H::TILE]);
            assert_eq!(pv.sites[site as usize], tile, "the Holding's tile is its site's tile");
            let origin = TileAddress::new(f.host.key(), tile).unwrap();
            (origin, vec![masks_of(dest, &c.account(&dest_key).unwrap().data), masks_of(f.host.key(), &home)])
        };
        let route = derive_route(origin, dest, &lands).expect("a passable route from the home tile into (129, 0)");
        let upper = travel_upper(&route.steps, &lands);
        let genesis_ts = f.genesis_ts;
        eprintln!("route: {} steps to tile {} via {} province(s); travel bound {upper}s", route.dirs.len(), route.dest_tile, route.keys.len());

        // 3. the player's real Depart with that route sealed (the seal stays
        //    in memory); the arrival bell is never earlier than the slowest
        //    doctrine's earliest (and at least 5 bells out, for the origin)
        let (b0, arrive, sealed) = real_depart_routed(&state, f, &player, &route.dirs, route.dest_tile, |bell, now| {
            let earliest = permutation_rules::frontier::travel::earliest_arrival_bell(genesis_ts, now, upper);
            let a = earliest.max(bell + 5);
            assert!(a <= bell + permutation_rules::frontier::travel::MAX_ARRIVAL_LEAD_BELLS, "the route is too long for one march");
            a
        });
        assert!(opened_rn <= arrive, "the destination resolves up to the arrival");
        // self-check against the recorded transit (the Reveal re-checks it all)
        {
            let c = lock(&state);
            let external = Address::new_from_array(transit_address(&ctx, &f.holding.to_bytes(), 0));
            let t = OwnedBridgeTransit::from_bytes(&ctx, &c.account(&external).unwrap().data).unwrap().transit();
            assert_eq!(t.origin, origin, "the program's origin tile is the one the route starts from");
            let unit = frontier_abi::entry::unit_from_u8(t.unit).expect("a unit");
            let raw = raw_secs(&route.steps, &lands, permutation_rules::frontier::travel::is_cavalry(unit));
            let secs = permutation_rules::frontier::doctrine::of_faction_v3(t.faction).unwrap().travel_secs(raw as u64) as u32;
            assert!(secs <= upper);
            permutation_rules::frontier::travel::check_arrival_bell(genesis_ts, t.depart_ts, secs, arrive)
                .unwrap_or_else(|e| panic!("the sealed arrival bell {arrive} fails the route's travel ({secs}s): {e:?}"));
        }

        // the synthetic Holding's rent payer is the fixture's funded test wallet
        // (a zero RENT_PAYER = the executable System Program, refused by SettleMember)
        {
            use frontier_abi::v2::layout::player::holding as H;
            let c = lock(&state);
            let hd = c.account(&f.holding).unwrap().data;
            assert_eq!(&hd[H::RENT_PAYER..H::RENT_PAYER + 32], f.rent_payer.as_ref());
            let rp = c.account(&f.rent_payer).expect("the rent payer is funded");
            assert!(!rp.executable && rp.lamports > 0);
        }

        // 4. only pilot ticks (+ the player's Reveal once its origin settled)
        let mut pilot = Pilot::new(&state, public_quicknet(), Some(f.holding), keep_rx()).await.unwrap();
        let test_addrs = fclient::addr::Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let clock = { let c = lock(&state); lk::season_clock(&c, &test_addrs).unwrap() };
        advance(&state, clock.genesis_ts + 600 * (b0 as i64 + 1) + 5);
        let mut origin_steps: Vec<String> = vec![];
        let mut revealed = None;
        let mut settled = false;
        for _ in 0..160 {
            assert!(pilot.tick(&state).await, "the keeper halted: {:?}", pilot.keeper.status);
            if let Some(s) = pilot.keeper.status.origin_step.clone() {
                if origin_steps.last() != Some(&s) {
                    origin_steps.push(s);
                }
            }
            let d = pilot.destination.as_ref().expect("a destination driver");
            if let Some(t) = d.terminal() {
                panic!("the destination driver stopped: {t:?}; its landed steps {:?}; origin {origin_steps:?}", d.log);
            }
            if matches!(d.last_step(), Some(crate::destination_driver::Step::Settled { .. })) {
                settled = true;
                break;
            }
            if revealed.is_none() && origin_steps.iter().any(|s| s.starts_with("Landed(\"SettleOrigin")) {
                let payer = Keypair::new();
                lock(&state).airdrop(&payer.pubkey(), 5_000_000_000).unwrap();
                let faction = {
                    let c = lock(&state);
                    let external = Address::new_from_array(transit_address(&ctx, &f.holding.to_bytes(), 0));
                    let t = OwnedBridgeTransit::from_bytes(&ctx, &c.account(&external).unwrap().data).unwrap().transit();
                    assert_eq!(t.arrive_bell, arrive);
                    t.faction
                };
                let ix = reveal_ix(&ctx, &payer.pubkey(), &f.holding, 0, faction, arrive, region, dest, &sealed, 0, &route);
                match submit_and_wait(&state, &payer, ix, "ExpeditionReveal(test player)", LAND_TIMEOUT, &mut keep_rx()).await {
                    Sent::Landed(sig) => revealed = Some((sig, faction)),
                    Sent::Failed(e) => panic!("the real Reveal was refused: {e}; origin {origin_steps:?}"),
                    Sent::Unknown { signature, why } => panic!("the Reveal's outcome is unknown ({signature}): {why}"),
                }
                continue;
            }
            let now = lock(&state).unix_timestamp();
            advance(&state, now + 120); // SYNTHETIC time
        }
        let d = pilot.destination.as_ref().unwrap();
        eprintln!("origin: {origin_steps:?}");
        eprintln!("reveal: {:?}", revealed.as_ref().map(|r| &r.0));
        eprintln!("destination: {:?}", d.log);
        eprintln!("synthetic: {}", opened["synthetic"]);
        assert!(settled, "not settled: {}", pilot.keeper.status.json());
        // a completed settlement is an arrival only if it stays (a settled defeat is not)
        assert!(d.last_step().is_some_and(|s| s.arrival_stays()), "the arrival did not stay: {:?}", d.last_step());
        let (_, faction) = revealed.expect("the Reveal landed");
        for k in ["GatherClash", "PostSeed", "ResolveFromInputs", "SettleOrigin"] {
            assert!(origin_steps.iter().any(|s| s.contains(k)), "origin {k} in {origin_steps:?}");
        }
        let has = |k: &str| d.log.iter().any(|s| s.starts_with("Landed(") && s.contains(k));
        assert!(has("ExpeditionGather(bell"), "{:?}", d.log);
        assert!(has(&format!("PostSeed(bell {arrive},")), "{:?}", d.log);
        assert!(has(&format!("Resolve(bell {arrive})")), "{:?}", d.log);
        assert!(has("SettleMember(transit 0)"), "{:?}", d.log);
        if opened_rn < arrive {
            assert!(has(&format!("Resolve(quiet bell {opened_rn})")), "the catch-up from {opened_rn}: {:?}", d.log);
        }
        // the program's own record: THIS position resolved and settled
        let c = lock(&state);
        let inputs = c.account(&Address::new_from_array(clash_inputs_address(&ctx, dest, arrive))).expect("the arrival's ClashInputs");
        let h = WideClashInputsHdr::read(&inputs.data).unwrap();
        assert!(h.flags & wide_clash_inputs::FLAG_RESOLVED != 0);
        assert!(h.settled_mask & (1 << (faction * 4)) != 0, "position {} settled", faction * 4);
        drop(c);
        play.running.stop();
    });
}
