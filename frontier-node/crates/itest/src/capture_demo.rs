//! **TEST-ONLY capture demo** (runner `--capture-demo capture-demo-v1 --demo-scale <10-60>`, launcher option of the
//! same words; never the natural preset's behaviour). On a natural world, after the player's own PlaceHome, this:
//!
//! 1. compresses THIS memory-only chain's clock by `--demo-scale` (the node's own scale control). The chain starts at
//!    the fixed g0, about a hundred days behind real time, so every drand round it asks for is already published; BLS
//!    verification is unchanged;
//! 2. creates **test participants** (each its own in-memory key, funded by the test chain's faucet) who Join and
//!    PlaceHome on the player's wedge until its folded occupancy passes θ (6,500 bps, the stricter value) — the
//!    program's own area-expansion rule (`map.rs` `ring_occupancy_met`);
//! 3. at least a turn after the last opening: FoldOccupancy 0/1/2, OpenRing, then the ring seed exactly as the keeper
//!    consumes it (its recorded round, public Quicknet, BLS-verified), then OpenProvince of the next-ring provinces
//!    next to the player's home province.
//!
//! Every step is the program's own instruction; no account is written directly; no game rule, parameter or turn length
//! changes (a turn is still 600 chain-seconds; a keep still takes 72 counted turns). Every line it prints says
//! `test_only: true`, the synthetic clock scale and the number of test participants.
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{ix, Address, Keypair, Signer};
use frontier_abi::layout::world::frontier as FR;
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::{locate, tile_offset, ProvinceCoord};
use permutation_rules::hex::{Hex, DIRECTIONS};
use serde_json::{json, Value};

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper as lk;

pub const DEMO_MODE: &str = "capture-demo-v1";
pub const DEMO_SCHEMA: &str = "frontier-localnet-capture-demo-v1";
/// The folded occupancy the demo settles to (the stricter θ).
pub const DEMO_THETA_BPS: u64 = 6_500;

/// `--demo-scale`: a whole number in 10..=60.
pub fn demo_scale(raw: &str) -> Option<u32> {
    if raw.is_empty() || raw.starts_with('0') || !raw.bytes().all(|b| b.is_ascii_digit()) { return None; }
    raw.parse::<u32>().ok().filter(|s| (10..=60).contains(s))
}

/// The demo options out of the runner's arguments: `(rest, Some(scale))` when both `--capture-demo capture-demo-v1` and
/// `--demo-scale <10-60>` are given exactly once; `(args, None)` when neither is; anything else is refused.
pub fn take_demo_args(args: Vec<String>) -> Result<(Vec<String>, Option<u32>), String> {
    let mut rest = vec![];
    let (mut mode, mut scale) = (None::<String>, None::<String>);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--capture-demo" => { if mode.is_some() { return Err("--capture-demo twice".into()); } mode = Some(it.next().ok_or("--capture-demo needs a value")?); }
            "--demo-scale" => { if scale.is_some() { return Err("--demo-scale twice".into()); } scale = Some(it.next().ok_or("--demo-scale needs a value")?); }
            _ => rest.push(a),
        }
    }
    match (mode, scale) {
        (None, None) => Ok((rest, None)),
        (Some(m), Some(s)) if m == DEMO_MODE => Ok((rest, Some(demo_scale(&s).ok_or("--demo-scale must be a whole number in 10..=60")?))),
        (Some(m), Some(_)) => Err(format!("--capture-demo must be exactly {DEMO_MODE}, not {m}")),
        _ => Err("--capture-demo and --demo-scale go together".into()),
    }
}

/// The runner's first line on a demo world: the `capture_demo` statement the launcher checks, and the `clock` text made
/// true for this world (the natural world's text says its clock is never moved again — here it is, by `scale`, once the
/// player's home is placed). A natural world never calls this, so its first line is unchanged.
pub fn demo_metadata(meta: &mut Value, scale: u32) {
    if let Some(m) = meta.as_object_mut() {
        m.insert("capture_demo".into(), json!({"mode": DEMO_MODE, "scale": scale, "test_only": true}));
        m.insert("clock".into(), json!(format!("SYNTHETIC before genesis (the chain's fixed g0); natural from ready-for-join until the player's home is placed; then SYNTHETIC x{scale} (TEST-ONLY capture demo: the node's scale control on this memory-only chain), never natural again")));
    }
}

fn line(step: &str, scale: u32, settlers: u32, extra: Value) -> Value {
    let mut v = json!({"schema": DEMO_SCHEMA, "demo_step": step, "test_only": true, "synthetic_clock_scale": scale, "test_participants": settlers});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) { o.extend(e); }
    v
}

/// The provinces that border province `p` (by its tiles' neighbours), in tile order, each once.
pub fn province_neighbours(p: (i32, i32)) -> Vec<(i32, i32)> {
    let c = ProvinceCoord::new(p.0, p.1).centre();
    let mut out = vec![];
    for t in 0..61u8 {
        let Some(o) = tile_offset(t) else { continue };
        let h = Hex::new(c.q + o.q, c.r + o.r);
        for (dq, dr) in DIRECTIONS {
            let (pc, _) = locate(Hex::new(h.q + dq, h.r + dr));
            let n = (pc.p, pc.q);
            if n != p && !out.contains(&n) { out.push(n); }
        }
    }
    out
}

/// The next-ring provinces that border province `home`, in order, each once.
pub fn next_ring_neighbours(home: (i32, i32), ring_next: u32) -> Vec<(i32, i32)> {
    province_neighbours(home).into_iter().filter(|n| ProvinceCoord::new(n.0, n.1).ring() == ring_next).collect()
}

/// What the demo opens, in order, so the player's home reaches the new ring `ring_next` through bordering provinces: the
/// chain outward one ring at a time (the first bordering province of the next ring at each step; none when the home
/// already borders `ring_next`), then every `ring_next` province bordering the chain's last province. Empty when no
/// such path exists: the demo then fails closed (never "ready" with nothing to reach).
pub fn demo_open_plan(home: (i32, i32), ring_next: u32) -> Vec<(i32, i32)> {
    let mut chain = vec![];
    let mut at = home;
    while ProvinceCoord::new(at.0, at.1).ring() + 1 < ring_next {
        let r = ProvinceCoord::new(at.0, at.1).ring() + 1;
        let Some(n) = province_neighbours(at).into_iter().find(|n| ProvinceCoord::new(n.0, n.1).ring() == r) else { return vec![] };
        chain.push(n);
        at = n;
    }
    let last = next_ring_neighbours(at, ring_next);
    if last.is_empty() { return vec![]; }
    chain.extend(last);
    chain
}

/// How many more first holdings a wedge needs to reach `theta_bps` of its `open` sites.
pub fn settlers_needed(occupied: u32, open: u32, theta_bps: u64) -> u32 {
    let want = (theta_bps * open as u64).div_ceil(10_000) as u32;
    want.saturating_sub(occupied)
}

async fn send(state: &Shared, k: &Keypair, ix: fclient::Instruction, what: &str, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<String, String> {
    match submit_and_wait(state, k, ix, what, Duration::from_secs(60), stop).await {
        Sent::Landed(sig) => Ok(sig),
        other => Err(format!("{what}: {other:?} (not resent)")),
    }
}

async fn funded(state: &Shared, lamports: u64, stop: &tokio::sync::watch::Receiver<bool>) -> Result<Keypair, String> {
    let k = Keypair::new();
    lock(state).airdrop(&k.pubkey(), lamports)?;
    for _ in 0..100 {
        if *stop.borrow() { return Err("stopped".into()); }
        if lock(state).balance(&k.pubkey()) > 0 { return Ok(k); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("the faucet's airdrop did not land".into())
}

fn bytes(state: &Shared, k: &Address) -> Result<Vec<u8>, String> {
    lock(state).account(k).map(|a| a.data).ok_or_else(|| format!("account {k} absent"))
}

fn u32x6(d: &[u8], off: usize) -> [u32; 6] {
    core::array::from_fn(|i| u32::from_le_bytes(d[off + 4 * i..off + 4 * i + 4].try_into().expect("4 bytes")))
}

fn free_site(state: &Shared, a: &Addresses, p: i16, q: i16) -> Option<u8> {
    use frontier_abi::v2::layout::province::{province as PV, site as SM};
    let pd = bytes(state, &a.province(p as i32, q as i32)).ok()?;
    (0..pd[PV::SITE_COUNT] as usize).find(|i| matches!(pd[PV::site(*i) + SM::STATE], SM::STATE_FREE | SM::STATE_RELEASED_FREE)).map(|i| i as u8)
}

/// Runs the demo setup on `state` (the natural world's chain, after the player's PlaceHome on `home`). Prints one line
/// per step through `out`. Stops at the first refusal or unknown outcome (nothing is resent) or on `stop`.
pub async fn run(state: Shared, a: Addresses, homes: Vec<(i16, i16, u8)>, home: (i16, i16), scale: u32, mut stop: tokio::sync::watch::Receiver<bool>, out: impl Fn(Value)) -> Result<(), String> {
    let mut settlers = 0u32;
    out(line("started", scale, 0, json!({"note": "a TEST world: the clock is synthetic and the extra villages are test participants"})));
    // 1. the synthetic clock (this memory-only chain only)
    lock(&state).set_scale(scale as f64);
    out(line("clock", scale, 0, json!({"chain_unix": lock(&state).unix_timestamp()})));
    let opener = funded(&state, 500_000_000_000, &stop).await?;
    let fold = |st: Shared, k: Keypair, mut s: tokio::sync::watch::Receiver<bool>, a: Addresses| async move {
        for part in 0..3u8 { send(&st, &k, ix::fold_occupancy(&a, k.pubkey(), part), &format!("FoldOccupancy {part}"), &mut s).await?; }
        Ok::<(), String>(())
    };
    // 2. test participants on the player's wedge, up to θ
    let wedge_of = |p: i32, q: i32| ProvinceCoord::new(p, q).wedge();
    let wh = wedge_of(home.0 as i32, home.1 as i32).ok_or("the home has no wedge")? as usize;
    let fill: Vec<(i16, i16, u8)> = homes.iter().copied().filter(|h| wedge_of(h.0 as i32, h.1 as i32) == Some(wh as u8)).collect();
    for _ in 0..8 {
        fold(state.clone(), opener.insecure_clone(), stop.clone(), a.clone()).await?;
        let fd = bytes(&state, &a.frontier())?;
        let (open, occ) = (u32x6(&fd, FR::WEDGE_OPEN)[wh], u32x6(&fd, FR::WEDGE_OCCUPIED)[wh]);
        let need = settlers_needed(occ, open, DEMO_THETA_BPS);
        out(line("occupancy", scale, settlers, json!({"wedge": wh, "occupied": occ, "open": open, "needed": need})));
        if need == 0 { break; }
        for _ in 0..need {
            let Some(&(fp, fq, nation)) = fill.iter().find(|h| free_site(&state, &a, h.0, h.1).is_some()) else { return Err(format!("no free site left in wedge {wh}")); };
            let k = funded(&state, 5_000_000_000, &stop).await?;
            let w = k.pubkey();
            let now = lock(&state).unix_timestamp();
            send(&state, &k, ix::join(&a, w, w, nation, &w, now + 3_600, None), "test participant Join", &mut stop).await?;
            let (f, sh) = crate::natural_play::joined(&bytes(&state, &a.citizen(&w))?, &w).ok_or("the test participant did not join")?;
            let site = free_site(&state, &a, fp, fq).ok_or("the site was taken")?;
            send(&state, &k, ix::place_home(&a, &fclient::ix::Player { actor: w, payer: w, wallet: w }, ix::Site { p: fp, q: fq, site }, f, sh), "test participant PlaceHome", &mut stop).await?;
            settlers += 1;
        }
    }
    out(line("settled", scale, settlers, json!({"wedge": wh})));
    // 3. a turn after the last opening: fold, OpenRing, the ring seed, the neighbours
    let clock = { let c = lock(&state); lk::season_clock(&c, &a)? };
    let last = u32::from_le_bytes(bytes(&state, &a.frontier())?[FR::LAST_RING_OPEN_BELL..][..4].try_into().map_err(|_| "Frontier")?);
    while clock.bell_at(lock(&state).unix_timestamp()).unwrap_or(0) < last + 1 {
        if *stop.borrow() { return Err("stopped".into()); }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    fold(state.clone(), opener.insecure_clone(), stop.clone(), a.clone()).await?;
    let d = u16::from_le_bytes(bytes(&state, &a.frontier())?[FR::RINGS_OPENED..][..2].try_into().map_err(|_| "Frontier")?);
    send(&state, &opener, ix::open_ring(&a, opener.pubkey(), d), "OpenRing", &mut stop).await?;
    out(line("ring_opened", scale, settlers, json!({"ring": d})));
    {
        use frontier_abi::layout::world::ring_seed as RS;
        let rs = fclient::decode::RingSeed::decode(&bytes(&state, &a.ring_seed(d))?).map_err(|e| format!("RingSeed: {e:?}"))?;
        if rs.status != RS::STATUS_REQUESTED { return Err(format!("the ring seed is in status {}", rs.status)); }
        while clock.drand.round_time(rs.round) > lock(&state).unix_timestamp() {
            if *stop.borrow() { return Err("stopped".into()); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let sig48 = lk::fetch_round_at(rs.round).await?;
        let arg = ix::BeaconArg { round: rs.round, sig48, hints: fclient::beacon::hints_bytes(rs.round) };
        send(&state, &opener, ix::consume_ring_seed(&a, opener.pubkey(), d, &arg), "ConsumeRingSeed", &mut stop).await?;
        out(line("ring_seeded", scale, settlers, json!({"ring": d, "round": rs.round})));
    }
    // the chain from the home outward, then the new ring's provinces at its end (fail-closed when there is none)
    let plan = demo_open_plan((home.0 as i32, home.1 as i32), d as u32);
    if plan.iter().all(|p| ProvinceCoord::new(p.0, p.1).ring() != d as u32) {
        return Err(format!("no province of ring {d} can be reached from the home {home:?}: not ready"));
    }
    let mut opened = vec![];
    for p in plan {
        if lock(&state).account(&a.province(p.0, p.1)).is_some() { continue; }
        send(&state, &opener, ix::open_province(&a, opener.pubkey(), p.0 as i16, p.1 as i16), &format!("OpenProvince {p:?}"), &mut stop).await?;
        opened.push(json!({"p": p.0, "q": p.1, "ring": ProvinceCoord::new(p.0, p.1).ring()}));
    }
    let reach: Vec<Value> = demo_open_plan((home.0 as i32, home.1 as i32), d as u32).into_iter().filter(|p| ProvinceCoord::new(p.0, p.1).ring() == d as u32 && lock(&state).account(&a.province(p.0, p.1)).is_some()).map(|p| json!({"p": p.0, "q": p.1})).collect();
    if reach.is_empty() { return Err(format!("no province of ring {d} is open next to the home's path: not ready")); }
    out(line("ready", scale, settlers, json!({"ring": d, "provinces_opened": opened, "new_ring_reachable": reach})));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_demo_options_are_explicit_exact_and_together() {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(take_demo_args(v(&["--keeper", "public-quicknet"])).unwrap(), (v(&["--keeper", "public-quicknet"]), None), "without them: the natural world, unchanged");
        assert_eq!(take_demo_args(v(&["--capture-demo", "capture-demo-v1", "--keeper", "k", "--demo-scale", "20"])).unwrap(), (v(&["--keeper", "k"]), Some(20)));
        assert!(take_demo_args(v(&["--capture-demo", "capture-demo-v2", "--demo-scale", "20"])).is_err(), "only the exact word");
        assert!(take_demo_args(v(&["--capture-demo", "capture-demo-v1"])).is_err(), "never alone");
        assert!(take_demo_args(v(&["--demo-scale", "20"])).is_err());
        assert!(take_demo_args(v(&["--capture-demo", "capture-demo-v1", "--capture-demo", "capture-demo-v1", "--demo-scale", "20"])).is_err());
        for bad in ["9", "61", "020", "", "20.0", "-20", "1e1"] { assert!(demo_scale(bad).is_none(), "{bad}"); }
        assert_eq!((demo_scale("10"), demo_scale("60")), (Some(10), Some(60)));
    }
    #[test]
    fn settlers_reach_theta_exactly_and_neighbours_are_the_next_ring_only() {
        assert_eq!(settlers_needed(1, 60, 6_500), 38, "39 of 60 = 6,500 bps");
        assert_eq!(settlers_needed(39, 60, 6_500), 0);
        assert_eq!(settlers_needed(70, 60, 6_500), 0);
        let n = next_ring_neighbours((-3, 0), 4);
        assert!(!n.is_empty() && n.iter().all(|p| ProvinceCoord::new(p.0, p.1).ring() == 4));
        assert!(n.contains(&(-4, 1)), "the fort province of the real test borders home (-3, 0)");
    }
    #[test]
    fn the_open_plan_reaches_the_new_ring_from_a_ring_three_and_a_ring_two_home_or_is_empty() {
        let ring = |p: &(i32, i32)| ProvinceCoord::new(p.0, p.1).ring();
        let adjacent = |a: (i32, i32), b: (i32, i32)| province_neighbours(a).contains(&b);
        // a ring-3 home borders ring 4 directly: no chain, only ring-4 provinces
        let r3 = demo_open_plan((-3, 0), 4);
        assert!(!r3.is_empty() && r3.iter().all(|p| ring(p) == 4 && adjacent((-3, 0), *p)));
        // a ring-2 home does not border ring 4 (the review's case): one ring-3 province first, then ring-4 provinces bordering it
        let h2 = (-2, 0);
        assert_eq!(ring(&h2), 2);
        assert!(next_ring_neighbours(h2, 4).is_empty(), "no ring-4 neighbour of a ring-2 home");
        let r2 = demo_open_plan(h2, 4);
        assert!(r2.len() >= 2 && ring(&r2[0]) == 3 && adjacent(h2, r2[0]), "the chain starts next to the home, one ring out");
        assert!(r2[1..].iter().all(|p| ring(p) == 4 && adjacent(r2[0], *p)), "then ring-4 provinces bordering the chain's end");
        // every home of the heartland rings 2..=3 gets a plan that ends in ring 4
        for p in -3..=3i32 { for q in -3..=3i32 {
            let r = ring(&(p, q));
            if (2..=3).contains(&r) { let plan = demo_open_plan((p, q), 4); assert!(plan.iter().any(|x| ring(x) == 4), "home {:?}", (p, q)); }
        } }
    }
    #[test]
    fn the_first_line_says_the_synthetic_clock_only_on_a_demo_world() {
        let natural = json!({"world": "natural", "clock": "SYNTHETIC only before genesis (the chain's fixed g0); NATURAL from ready-for-join on, never moved again"});
        // (a natural world never calls demo_metadata: its line is the runner's own, unchanged)
        let mut demo = natural.clone();
        demo_metadata(&mut demo, 20);
        assert_eq!(demo["capture_demo"], json!({"mode": DEMO_MODE, "scale": 20, "test_only": true}));
        let clock = demo["clock"].as_str().unwrap();
        assert!(clock.contains("SYNTHETIC x20") && clock.contains("TEST-ONLY capture demo") && !clock.contains("never moved again"), "{clock}");
        assert_eq!(demo["world"], natural["world"], "nothing else changes");
        assert_eq!(demo.as_object().unwrap().len(), natural.as_object().unwrap().len() + 1, "only capture_demo added, clock replaced");
    }
    #[test]
    fn every_line_says_test_only_with_its_clock_and_participants() {
        let l = line("ready", 20, 38, json!({"ring": 4}));
        assert_eq!((l["test_only"].as_bool(), l["synthetic_clock_scale"].as_u64(), l["test_participants"].as_u64(), l["ring"].as_u64()), (Some(true), Some(20), Some(38), Some(4)));
    }
}
