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
use frontier_abi::layout::player::holding_ref as HR;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::world::season::GENESIS_SEED as SEASON_GENESIS_SEED;
use frontier_abi::v2::presets::ConquestParams;
use permutation_rules::frontier::geometry::{home_nation, locate, tile_offset, ProvinceCoord};
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

/// The most provinces a march may enter, and the most steps it may take (the program's `travel::path_cost`).
pub use permutation_rules::frontier::travel::{MAX_PATH_PROVINCES, MAX_PATH_STEPS};

/// Candidate targets for the demo, nearest first: each new-ring (`ring_next`) province whose keep holder — `holder_of`,
/// the program's own rule (`map.rs` `open_province`: `home_nation(...)` else the wedge) — is a nation other than
/// `player`, with the shortest province path to it from `home` (home first; provinces below the new ring; home, path and
/// target together at most [`MAX_PATH_PROVINCES`]). Each target once, by its first-found shortest path (neighbour order).
/// This is only a shortlist: the province-level path does not prove a march can walk it (see [`check_candidate`]).
pub fn foreign_keep_candidates(home: (i32, i32), ring_next: u32, player: u8, holder_of: impl Fn((i32, i32)) -> Option<u8>) -> Vec<(Vec<(i32, i32)>, (i32, i32))> {
    let foreign = |t: (i32, i32)| ProvinceCoord::new(t.0, t.1).ring() == ring_next && holder_of(t).is_some_and(|n| n != player);
    let mut out: Vec<(Vec<(i32, i32)>, (i32, i32))> = vec![];
    if ProvinceCoord::new(home.0, home.1).ring() >= ring_next { return out; }
    let mut paths: Vec<Vec<(i32, i32)>> = vec![vec![home]];
    let mut seen = vec![home];
    let mut i = 0;
    while i < paths.len() {
        let path = paths[i].clone();
        i += 1;
        let at = *path.last().unwrap();
        for t in province_neighbours(at) {
            if foreign(t) && !out.iter().any(|(_, x)| *x == t) { out.push((path.clone(), t)); }
        }
        if path.len() + 1 >= MAX_PATH_PROVINCES { continue; }
        for n in province_neighbours(at) {
            if ProvinceCoord::new(n.0, n.1).ring() < ring_next && !seen.contains(&n) {
                seen.push(n);
                let mut next = path.clone();
                next.push(n);
                paths.push(next);
            }
        }
    }
    out
}

/// The shortest walk a march could submit (`travel::path_cost`): from tile `start.1` of `start.0` (where the page musters
/// the host: the village's own tile; the start itself is not checked) to tile `goal.1` of `goal.0`, every step to an
/// adjacent tile that is passable in its province's recorded `passable_mask`, staying inside `provinces` (at most
/// [`MAX_PATH_PROVINCES`], so the provinces entered never exceed it), at most [`MAX_PATH_STEPS`] steps. Directions, or
/// `None`.
pub fn tile_route(start: ((i32, i32), u8), goal: ((i32, i32), u8), provinces: &[((i32, i32), u64)]) -> Option<Vec<u8>> {
    use std::collections::{HashMap, VecDeque};
    if provinces.len() > MAX_PATH_PROVINCES { return None; }
    let hex = |pc: (i32, i32), t: u8| { let c = ProvinceCoord::new(pc.0, pc.1).centre(); tile_offset(t).map(|o| Hex::new(c.q + o.q, c.r + o.r)) };
    let mask = |pc: (i32, i32)| provinces.iter().find(|(p, _)| *p == pc).map(|(_, m)| *m);
    let (s, g) = (hex(start.0, start.1)?, hex(goal.0, goal.1)?);
    let mut prev: HashMap<(i32, i32), Option<((i32, i32), u8)>> = HashMap::from([((s.q, s.r), None)]);
    let mut depth: HashMap<(i32, i32), usize> = HashMap::from([((s.q, s.r), 0)]);
    let mut queue = VecDeque::from([s]);
    while let Some(h) = queue.pop_front() {
        if (h.q, h.r) == (g.q, g.r) {
            let mut dirs = vec![];
            let mut cur = (h.q, h.r);
            while let Some(Some((from, d))) = prev.get(&cur) { dirs.push(*d); cur = *from; }
            dirs.reverse();
            return (!dirs.is_empty() && dirs.len() <= MAX_PATH_STEPS).then_some(dirs);
        }
        let dh = depth[&(h.q, h.r)];
        if dh >= MAX_PATH_STEPS { continue; }
        for d in 0..6u8 {
            let (dq, dr) = DIRECTIONS[d as usize];
            let n = Hex::new(h.q + dq, h.r + dr);
            if prev.contains_key(&(n.q, n.r)) { continue; }
            let (npc, nt) = locate(n);
            let Some(m) = mask((npc.p, npc.q)) else { continue };
            if nt < 61 && m & (1u64 << nt) != 0 {
                prev.insert((n.q, n.r), Some(((h.q, h.r), d)));
                depth.insert((n.q, n.r), dh + 1);
                queue.push_back(n);
            }
        }
    }
    None
}

/// What the chain records for one province, read after the program's own OpenProvince: its `passable_mask`, and its
/// keep as `(holder, tile, heartland_safe)` when it has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProvinceView { pub passable: u64, pub keep: Option<(u8, u8, bool)> }

/// One candidate judged on the chain's own records (`view`): the target's keep exists, is held by a nation other than
/// `player` (0–5), is not heartland-safe, and a march from the village tile `start` reaches the keep's tile within the
/// path's provinces ([`tile_route`]). The route, or why not (the demo then tries the next candidate).
pub fn check_candidate(path: &[(i32, i32)], target: (i32, i32), start: ((i32, i32), u8), player: u8, view: impl Fn((i32, i32)) -> Option<ProvinceView>) -> Result<Vec<u8>, String> {
    let tv = view(target).ok_or_else(|| format!("{target:?} is not open"))?;
    let (holder, tile, safe) = tv.keep.ok_or_else(|| format!("{target:?} has no keep"))?;
    if holder > 5 || holder == player { return Err(format!("{target:?}'s keep is held by {holder}, not another nation")); }
    if safe { return Err(format!("{target:?}'s keep is heartland-safe")); }
    let mut provinces = vec![];
    for p in path.iter().chain(std::iter::once(&target)) {
        let v = view(*p).ok_or_else(|| format!("{p:?} is not open"))?;
        if !provinces.iter().any(|(q, _)| q == p) { provinces.push((*p, v.passable)); }
    }
    tile_route(start, (target, tile), &provinces).ok_or_else(|| format!("no walk of at most {MAX_PATH_STEPS} passable steps over {} provinces from tile {} of {:?} to the keep tile {tile} of {target:?}", provinces.len(), start.1, start.0))
}

/// TEST-ONLY contest pair: the fort both players are given, and how each reaches it (shared with the runner, which re-checks
/// it on the chain's records once the second player's own PlaceHome has landed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairTarget {
    pub target: (i32, i32),
    pub keep_tile: u8,
    /// The nation that holds the fort: the second player plays it (to defend), the first contests it.
    pub nation: u8,
    pub a_start: ((i32, i32), u8),
    pub a_steps: usize,
    /// The second player's home as the page will place it (or as it already is): province, site, its tile.
    pub b_home: ((i32, i32), u8, u8),
    pub b_steps: usize,
}
pub type PairSlot = std::sync::Arc<std::sync::Mutex<Option<PairTarget>>>;

/// The page's own first-home choice (`home.mjs` `planHomes` with `controller.mjs`'s seed `"{wallet}|0"`): among the
/// provinces with free home sites for that nation, innermost ring first, then `hash32("{seed}|{p},{q}")`; in the first
/// such province, the free site with the lowest `hash32("{seed}|{p},{q},{site}")`. `provinces`: `((p, q), free sites)`.
pub fn predict_home(provinces: &[((i32, i32), Vec<u8>)], seed: &str) -> Option<((i32, i32), u8)> {
    use frontier_bots::home::hash32;
    let mut cands: Vec<&((i32, i32), Vec<u8>)> = provinces.iter().filter(|(_, sites)| !sites.is_empty()).collect();
    cands.sort_by_key(|((p, q), _)| (ProvinceCoord::new(*p, *q).ring(), hash32(&format!("{seed}|{p},{q}"))));
    let ((p, q), sites) = cands.first()?;
    let site = *sites.iter().min_by_key(|s| (hash32(&format!("{seed}|{p},{q},{s}")), **s))?;
    Some(((*p, *q), site))
}

/// The shortest province path from `from` to `target` (through provinces below `ring_next`; at most
/// [`MAX_PATH_PROVINCES`] together with the target), `from` first and the target excluded; `None` when there is none.
pub fn province_path(from: (i32, i32), target: (i32, i32), ring_next: u32) -> Option<Vec<(i32, i32)>> {
    let mut paths: Vec<Vec<(i32, i32)>> = vec![vec![from]];
    let mut seen = vec![from];
    let mut i = 0;
    while i < paths.len() {
        let path = paths[i].clone();
        i += 1;
        let at = *path.last().unwrap();
        if province_neighbours(at).contains(&target) { return Some(path); }
        if path.len() + 1 >= MAX_PATH_PROVINCES { continue; }
        for n in province_neighbours(at) {
            if ProvinceCoord::new(n.0, n.1).ring() < ring_next && !seen.contains(&n) { seen.push(n); let mut next = path.clone(); next.push(n); paths.push(next); }
        }
    }
    None
}

/// A march from `start` to the keep tile of `target` over `path` ∪ {target} on the chain's records (`view`): the route.
pub fn route_on(path: &[(i32, i32)], target: (i32, i32), keep_tile: u8, start: ((i32, i32), u8), view: impl Fn((i32, i32)) -> Option<ProvinceView>) -> Result<Vec<u8>, String> {
    let mut provinces = vec![];
    for p in path.iter().chain(std::iter::once(&target)) {
        let v = view(*p).ok_or_else(|| format!("{p:?} is not open"))?;
        if !provinces.iter().any(|(q, _)| q == p) { provinces.push((*p, v.passable)); }
    }
    tile_route(start, (target, keep_tile), &provinces).ok_or_else(|| format!("no walk of at most {MAX_PATH_STEPS} passable steps from tile {} of {:?} to the keep tile {keep_tile} of {target:?}", start.1, start.0))
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

/// The second player's home for the fort's nation `nation`: its own, if its Citizen already has one (and it is of that
/// nation), else where the page will place it ([`predict_home`] over the chain's free sites, seed `"{wallet}|0"`).
/// `((p, q), site, tile)`.
fn b_home_for(state: &Shared, a: &Addresses, b: &Address, nation: u8, cq: &ConquestParams, seed: &[u8; 32], rings: u16) -> Result<((i32, i32), u8, u8), String> {
    let c = lock(state);
    if let Some(acc) = c.account(&a.citizen(b)) {
        let cit = acc.data;
        if cit.get(C::FLAGS).is_some_and(|f| f & C::FLAG_HOME_GRANTED != 0) {
            let slot = C::holding_of_slot(1);
            let at = |o: usize| cit.get(slot + o..slot + o + 2).map(|x| i16::from_le_bytes([x[0], x[1]]) as i32);
            let (p, q, site) = (at(HR::P).ok_or("B's home slot")?, at(HR::Q).ok_or("B's home slot")?, *cit.get(slot + HR::SITE).ok_or("B's home slot")?);
            if cit.get(C::FACTION) != Some(&nation) { return Err(format!("the second player already plays nation {:?}, not {nation}", cit.get(C::FACTION))); }
            let h = fclient::decode::Holding::decode(&c.account(&a.holding(p, q, site)).ok_or("B's Holding")?.data).map_err(|e| format!("B's Holding: {e:?}"))?;
            return Ok(((p, q), site, h.tile));
        }
    }
    let clock = lk::season_clock(&c, a)?;
    let bell = clock.bell_at(c.unix_timestamp()).unwrap_or(0);
    let mut provs: Vec<((i32, i32), Vec<u8>)> = vec![];
    let mut tiles: Vec<((i32, i32), [u8; 12])> = vec![];
    for ring in 2..=cq.heartland_max_ring as i32 {
        for p in -ring..=ring { for q in -ring..=ring {
            let pc = ProvinceCoord::new(p, q);
            if pc.ring() as i32 != ring || home_nation(pc, cq.placement, cq.heartland_max_ring, seed) != Some(nation) { continue; }
            let Some(acc) = c.account(&a.province(p, q)) else { continue };
            let Ok(pv) = fclient::decode::Province::decode(&acc.data) else { continue };
            let sites = frontier_bots::home::home_sites(&pv, nation, bell, rings, Some(cq.heartland_max_ring as u16), Some((cq.placement, cq.heartland_max_ring, *seed)));
            provs.push(((p, q), sites.iter().map(|s| s.site).collect()));
            tiles.push(((p, q), pv.sites));
        } }
    }
    let ((p, q), site) = predict_home(&provs, &format!("{b}|0")).ok_or_else(|| format!("no free home site for nation {nation}"))?;
    let tile = tiles.iter().find(|(x, _)| *x == (p, q)).map(|(_, t)| t[site as usize]).ok_or("the predicted site's tile")?;
    Ok(((p, q), site, tile))
}

/// TEST-ONLY contest pair: once the second player's own PlaceHome has landed and the demo has chosen the fort, both routes
/// are checked again on the chain's records (A's village tile and B's actual village tile to the keep tile, B playing the
/// fort's nation). The `pair_ready` line, or why not (`pair_not_ready`). Reads only.
pub fn verify_pair(state: &Shared, a: &Addresses, b: &Address, t: &PairTarget) -> Result<Value, String> {
    let c = lock(state);
    let cit = c.account(&a.citizen(b)).ok_or("the second player's Citizen")?.data;
    let slot = C::holding_of_slot(1);
    let at = |o: usize| cit.get(slot + o..slot + o + 2).map(|x| i16::from_le_bytes([x[0], x[1]]) as i32);
    let (p, q, site) = (at(HR::P).ok_or("B's home slot")?, at(HR::Q).ok_or("B's home slot")?, *cit.get(slot + HR::SITE).ok_or("B's home slot")?);
    let h = fclient::decode::Holding::decode(&c.account(&a.holding(p, q, site)).ok_or("B's Holding")?.data).map_err(|e| format!("B's Holding: {e:?}"))?;
    if h.faction != t.nation { return Err(format!("the second player plays nation {}, the fort's is {}", h.faction, t.nation)); }
    let view = |pc: (i32, i32)| -> Option<ProvinceView> {
        let pv = fclient::decode::Province::decode(&c.account(&a.province(pc.0, pc.1))?.data).ok()?;
        Some(ProvinceView { passable: pv.passable_mask, keep: pv.cq.as_ref().and_then(|x| x.keep).map(|k| (k.holder, k.tile, k.heartland_safe)) })
    };
    let ring = ProvinceCoord::new(t.target.0, t.target.1).ring();
    let keep = view(t.target).and_then(|v| v.keep).ok_or("the fort has no keep")?;
    if keep.0 != t.nation { return Err(format!("the fort is now held by {}, not {}", keep.0, t.nation)); }
    let ap = province_path(t.a_start.0, t.target, ring).ok_or("no province path for the first player")?;
    let ar = route_on(&ap, t.target, t.keep_tile, t.a_start, view).map_err(|e| format!("first player: {e}"))?;
    let bp = province_path((p, q), t.target, ring).ok_or("no province path for the second player")?;
    let br = route_on(&bp, t.target, t.keep_tile, ((p, q), h.tile), view).map_err(|e| format!("second player: {e}"))?;
    Ok(json!({"target": {"p": t.target.0, "q": t.target.1, "keep_tile": t.keep_tile, "holder": keep.0}, "first_steps": ar.len(), "second_home": {"p": p, "q": q, "site": site, "tile": h.tile}, "second_steps": br.len(), "as_predicted": ((p, q), site) == (t.b_home.0, t.b_home.1)}))
}

/// Runs the demo setup on `state` (the natural world's chain, after the player's PlaceHome on `home`). Prints one line
/// per step through `out`. Stops at the first refusal or unknown outcome (nothing is resent) or on `stop`.
pub async fn run(state: Shared, a: Addresses, homes: Vec<(i16, i16, u8)>, home: (i16, i16), player: Address, pair: Option<(Address, PairSlot)>, scale: u32, mut stop: tokio::sync::watch::Receiver<bool>, out: impl Fn(Value)) -> Result<(), String> {
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
    // a new-ring province whose keep ANOTHER nation holds AND that a march from the village can actually reach: the
    // shortlist by the program's own holder rule (read from the Season; the player's nation from its own Citizen), then,
    // after the program's own OpenProvince, each candidate judged on the chain's records (keep holder, passable tiles,
    // the keep tile, ≤ 32 steps over ≤ 4 provinces). The first that passes is the target; none is an explicit not-ready.
    let sd = bytes(&state, &a.season)?;
    let cq = ConquestParams::of_season(&sd).ok_or("the Season's conquest params")?;
    let seed: [u8; 32] = sd.get(SEASON_GENESIS_SEED..SEASON_GENESIS_SEED + 32).and_then(|s| s.try_into().ok()).ok_or("the Season's seed")?;
    let cit = bytes(&state, &a.citizen(&player))?;
    let nation = *cit.get(C::FACTION).ok_or("the player's Citizen is too short")?;
    if nation > 5 { return Err(format!("the player's Citizen names nation {nation}")); }
    let slot = C::holding_of_slot(1);
    let at = |o: usize| cit.get(slot + o..slot + o + 2).map(|b| i16::from_le_bytes([b[0], b[1]]));
    let (hp, hq, hs) = (at(HR::P).ok_or("the Citizen's home slot")?, at(HR::Q).ok_or("the Citizen's home slot")?, *cit.get(slot + HR::SITE).ok_or("the Citizen's home slot")?);
    if (hp, hq) != home { return Err(format!("the Citizen's home {:?} is not the PlaceHome's {home:?}", (hp, hq))); }
    let village = fclient::decode::Holding::decode(&bytes(&state, &a.holding(hp as i32, hq as i32, hs))?).map_err(|e| format!("the player's Holding: {e:?}"))?;
    // (the march's host takes its nation from the Holding: the Citizen and the Holding must say the same, or not ready)
    if village.faction != nation { return Err(format!("the player's Holding names nation {}, its Citizen {nation}: not ready", village.faction)); }
    let start = ((home.0 as i32, home.1 as i32), village.tile);
    let holder_of = |t: (i32, i32)| { let pc = ProvinceCoord::new(t.0, t.1); home_nation(pc, cq.placement, cq.heartland_max_ring, &seed).or(pc.wedge()) };
    let cands = foreign_keep_candidates((home.0 as i32, home.1 as i32), d as u32, nation, holder_of);
    if cands.is_empty() { return Err(format!("no keep of another nation than {nation} in ring {d} lies within {MAX_PATH_PROVINCES} provinces of the home {home:?}: not ready")); }
    let view = |pc: (i32, i32)| -> Option<ProvinceView> {
        let pv = fclient::decode::Province::decode(&bytes(&state, &a.province(pc.0, pc.1)).ok()?).ok()?;
        Some(ProvinceView { passable: pv.passable_mask, keep: pv.cq.as_ref().and_then(|c| c.keep).map(|k| (k.holder, k.tile, k.heartland_safe)) })
    };
    let mut opened = vec![];
    let mut refused = vec![];
    let mut chosen = None;
    for (path, target) in cands.iter().take(12) {
        let mut refused_open = None;
        for p in path.iter().skip(1).chain(std::iter::once(target)) {
            if lock(&state).account(&a.province(p.0, p.1)).is_some() { continue; }
            let ix = ix::open_province(&a, opener.pubkey(), p.0 as i16, p.1 as i16);
            // (simulated first: a refusal sends nothing and moves on to the next candidate; a sent one whose outcome is
            //  unknown still stops the demo, never resent)
            let sim = { let c = lock(&state); lk::simulate_ix(&c, &opener, &ix) };
            match sim {
                Ok(r) if r.err.is_none() => {}
                Ok(r) => { refused_open = Some(format!("OpenProvince {p:?} refused in simulation: {:?} (code {:?})", r.err, r.code)); break; }
                Err(e) => { refused_open = Some(format!("OpenProvince {p:?} not simulated: {e}")); break; }
            }
            send(&state, &opener, ix, &format!("OpenProvince {p:?}"), &mut stop).await?;
            opened.push(json!({"p": p.0, "q": p.1, "ring": ProvinceCoord::new(p.0, p.1).ring()}));
        }
        if let Some(why) = refused_open { refused.push(json!({"p": target.0, "q": target.1, "why": why})); continue; }
        match check_candidate(path, *target, start, nation, view) {
            Ok(route) => {
                // (the contest pair: the fort's nation is the second player's; its home — already placed, or where the page
                //  will place it — must reach the same fort over the chain's records, or the next candidate is tried)
                if let Some((b, slot)) = &pair {
                    let Some((holder, keep_tile, _)) = view(*target).and_then(|v| v.keep) else { continue };
                    match b_home_for(&state, &a, b, holder, &cq, &seed, d) {
                        Ok(bh) => {
                            let bpath = province_path(bh.0, *target, d as u32);
                            match bpath.ok_or_else(|| format!("no province path from {:?} to {target:?}", bh.0)).and_then(|bp| route_on(&bp, *target, keep_tile, (bh.0, bh.2), view)) {
                                Ok(broute) => {
                                    *slot.lock().unwrap() = Some(PairTarget { target: *target, keep_tile, nation: holder, a_start: start, a_steps: route.len(), b_home: bh, b_steps: broute.len() });
                                }
                                Err(why) => { refused.push(json!({"p": target.0, "q": target.1, "why": format!("second player: {why}")})); continue; }
                            }
                        }
                        Err(why) => { refused.push(json!({"p": target.0, "q": target.1, "why": format!("second player: {why}")})); continue; }
                    }
                }
                chosen = Some((*target, route.len(), view(*target).and_then(|v| v.keep))); break;
            }
            Err(why) => refused.push(json!({"p": target.0, "q": target.1, "why": why})),
        }
    }
    let Some((target, steps, Some((holder, tile, _)))) = chosen else {
        return Err(format!("no keep of another nation than {nation} in ring {d} is reachable by a march from the village tile {} of {home:?} ({} candidates refused): not ready", start.1, refused.len()));
    };
    let pair_line = pair.as_ref().and_then(|(_, slot)| slot.lock().unwrap().clone()).map(|t| json!({"second_player_nation": t.nation, "second_player_home": {"p": t.b_home.0.0, "q": t.b_home.0.1, "site": t.b_home.1, "tile": t.b_home.2}, "second_player_route_steps": t.b_steps}));
    if pair.is_some() && pair_line.is_none() { return Err(format!("no fort in ring {d} is reachable by both players: not ready")); }
    out(line("ready", scale, settlers, json!({"ring": d, "player_nation": nation, "provinces_opened": opened, "refused": refused, "pair": pair_line,
        "new_ring_reachable": [{"p": target.0, "q": target.1, "keep_holder": holder, "keep_tile": tile, "route_steps": steps, "from_tile": start.1}]})));
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

    // ---- another nation's keep that a march can reach (trial 4: both opened keeps were the player's own nation's)
    fn wedge_holder(t: (i32, i32)) -> Option<u8> { ProvinceCoord::new(t.0, t.1).wedge() }
    fn trial4_home() -> (i32, i32) {
        (-3..=3i32).flat_map(|p| (-3..=3i32).map(move |q| (p, q)))
            .find(|h| (2..=3).contains(&ProvinceCoord::new(h.0, h.1).ring()) && demo_open_plan(*h, 4) == vec![(1, 3), (2, 2)])
            .expect("the trial-4 home")
    }
    fn check_shortlist(home: (i32, i32), nation: u8, cands: &[(Vec<(i32, i32)>, (i32, i32))]) {
        for (path, t) in cands {
            assert_eq!(path[0], home);
            assert_eq!(ProvinceCoord::new(t.0, t.1).ring(), 4);
            assert!(wedge_holder(*t).is_some_and(|n| n != nation), "{t:?} is another nation's");
            for w in path.windows(2) { assert!(province_neighbours(w[0]).contains(&w[1]), "province to province"); }
            assert!(province_neighbours(*path.last().unwrap()).contains(t), "the target borders the path's end");
            assert!(path.len() + 1 <= MAX_PATH_PROVINCES, "at most {MAX_PATH_PROVINCES} provinces");
            assert!(path[1..].iter().all(|p| ProvinceCoord::new(p.0, p.1).ring() < 4), "through rings below the new one");
        }
    }
    #[test]
    fn the_trial_4_home_shortlists_only_other_nations_keeps() {
        let h = trial4_home();
        assert!([(1, 3), (2, 2)].iter().all(|t| wedge_holder(*t) == Some(0)), "both old targets were wedge 0's");
        let c = foreign_keep_candidates(h, 4, 0, wedge_holder);
        assert!(!c.is_empty(), "another nation's keep is within 4 provinces");
        check_shortlist(h, 0, &c);
        assert!(c.iter().all(|(_, t)| *t != (1, 3) && *t != (2, 2)), "never the player's own keeps");
        // nearest first
        assert!(c.windows(2).all(|w| w[0].0.len() <= w[1].0.len()));
    }
    #[test]
    fn every_heartland_home_and_nation_gets_a_valid_shortlist_and_none_means_not_ready() {
        // the shortlist is only province-level: whether a march can walk it is decided on the chain's records
        // (check_candidate), and an empty shortlist or no reachable candidate is an explicit not-ready in `run`
        let (mut with, mut without) = (0, 0);
        for p in -3..=3i32 { for q in -3..=3i32 {
            if !(2..=3).contains(&ProvinceCoord::new(p, q).ring()) { continue; }
            for nation in 0..6u8 {
                let c = foreign_keep_candidates((p, q), 4, nation, wedge_holder);
                check_shortlist((p, q), nation, &c);
                if c.is_empty() { without += 1 } else { with += 1 }
            }
        } }
        assert!(with > 0, "with {with}, without {without}");
        assert!(foreign_keep_candidates((1, 4), 4, 0, wedge_holder).is_empty(), "a home outside the new ring only");
        assert!(foreign_keep_candidates((-3, 0), 4, 0, |_| Some(0)).is_empty(), "all the player's own: none");
        assert!(foreign_keep_candidates((-3, 0), 4, 0, |_| None).is_empty(), "unknown holders: none");
    }
    const ALL: u64 = (1u64 << 61) - 1;
    fn tile_hex(pc: (i32, i32), t: u8) -> Hex { let c = ProvinceCoord::new(pc.0, pc.1).centre(); let o = tile_offset(t).unwrap(); Hex::new(c.q + o.q, c.r + o.r) }
    #[test]
    fn a_route_walks_passable_tiles_only_and_never_past_32_steps_or_4_provinces() {
        let home = (-3, 0);
        let t = next_ring_neighbours(home, 4)[0];
        // all passable: a route exists, each step adjacent
        let r = tile_route((home, 30), (t, 30), &[(home, ALL), (t, ALL)]).expect("a route over open ground");
        assert!(!r.is_empty() && r.len() <= MAX_PATH_STEPS);
        // the target province entirely impassable except the goal: no way in
        assert_eq!(tile_route((home, 30), (t, 30), &[(home, ALL), (t, 1u64 << 30)]), None, "the goal alone, walled off");
        // the target province not among the allowed ones: no route
        assert_eq!(tile_route((home, 30), (t, 30), &[(home, ALL)]), None);
        // more than four provinces: refused
        let five: Vec<((i32, i32), u64)> = [home, t, (0, 0), (1, 0), (0, 1)].iter().map(|p| (*p, ALL)).collect();
        assert_eq!(tile_route((home, 30), (t, 30), &five), None);
        // farther than 32 steps by hex distance: never a route, whatever the masks
        let path = [(-3, 0), (-2, 0), (-1, 0), (0, 0)];
        let (s, g) = ((path[0], 0..61u8), (path[3], 0..61u8));
        let far = s.1.clone().flat_map(|a| g.1.clone().map(move |b| (a, b))).find(|(a, b)| tile_hex(path[0], *a).distance(tile_hex(path[3], *b)) > MAX_PATH_STEPS as u32).expect("a pair farther than 32");
        let masks: Vec<((i32, i32), u64)> = path.iter().map(|p| (*p, ALL)).collect();
        assert_eq!(tile_route((path[0], far.0), (path[3], far.1), &masks), None, "over 32 steps");
        let _ = (s, g);
    }
    #[test]
    fn a_candidate_passes_only_on_the_chains_records_with_a_walkable_route() {
        let home = (-3, 0);
        let t = next_ring_neighbours(home, 4)[0];
        let start = (home, 30);
        let open = |keep: Option<(u8, u8, bool)>, tmask: u64| move |pc: (i32, i32)| -> Option<ProvinceView> {
            if pc == home { Some(ProvinceView { passable: ALL, keep: None }) } else if pc == t { Some(ProvinceView { passable: tmask, keep }) } else { None }
        };
        assert!(check_candidate(&[home], t, start, 0, open(Some((3, 30, false)), ALL)).is_ok(), "another nation's keep, open ground");
        assert!(check_candidate(&[home], t, start, 0, open(Some((0, 30, false)), ALL)).unwrap_err().contains("not another nation"), "the player's own");
        assert!(check_candidate(&[home], t, start, 0, open(Some((6, 30, false)), ALL)).unwrap_err().contains("not another nation"), "the Concord / none");
        assert!(check_candidate(&[home], t, start, 0, open(Some((3, 30, true)), ALL)).unwrap_err().contains("heartland-safe"));
        assert!(check_candidate(&[home], t, start, 0, open(None, ALL)).unwrap_err().contains("no keep"));
        assert!(check_candidate(&[home], t, start, 0, open(Some((3, 30, false)), 1u64 << 30)).unwrap_err().contains("no walk"), "impassable: refused, never assumed");
        assert!(check_candidate(&[home], t, start, 0, |_| None).unwrap_err().contains("not open"));
        assert!(check_candidate(&[home, (-2, 0)], t, start, 0, open(Some((3, 30, false)), ALL)).unwrap_err().contains("not open"), "an unopened path province");
    }
    #[test]
    fn the_run_judges_targets_on_the_chain_and_writes_nothing_directly() {
        let src = include_str!("capture_demo.rs");
        let run = &src[src.find("pub async fn run(").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(run.contains("home_nation(pc, cq.placement, cq.heartland_max_ring, &seed).or(pc.wedge())"), "the program's holder rule (map.rs open_province)");
        assert!(run.contains("bytes(&state, &a.citizen(&player))?") && run.contains("C::FACTION"), "the player's nation from its own Citizen");
        assert!(run.contains("fclient::decode::Holding::decode(&bytes(&state, &a.holding(") && run.contains("village.tile"), "the march starts on the village tile, as the page musters");
        assert!(run.contains("passable: pv.passable_mask") && run.contains("c.keep).map(|k| (k.holder, k.tile, k.heartland_safe))"), "the chain's own records");
        assert!(run.contains("check_candidate(path, *target, start, nation, view)") && run.contains("refused.push("), "each candidate judged; refusals kept");
        assert!(run.contains(": not ready\"") || run.contains("not ready\", "), "an explicit not-ready");
        assert!(!run.contains("demo_open_plan(") && !run.contains("foreign_keep_plan("), "no unverified plan decides the target");
        for w in ["set_account", "write_account", "account_mut", ".store("] { assert!(!run.contains(w), "nothing is written directly: {w}"); }
        let bin = include_str!("bin/localnet_natural_play.rs");
        assert!(bin.contains("itest::capture_demo::run(st, a, homes, h, player, pair, scale, rx, "), "the runner passes the player's wallet (and the pair slot)");
        // (review: the host's nation is the Holding's; the two must agree)
        assert!(run.contains("if village.faction != nation {"), "Holding and Citizen nations agree, or not ready");
        // (review: a refused OpenProvince is simulated first and moves on to the next candidate; nothing is sent for it)
        let open_at = run.find("let ix = ix::open_province(").unwrap();
        let sim_at = run[open_at..].find("lk::simulate_ix(&c, &opener, &ix)").unwrap();
        let send_at = run[open_at..].find("send(&state, &opener, ix, ").unwrap();
        assert!(sim_at < send_at, "simulated before it is sent");
        assert!(run.contains("if let Some(why) = refused_open { refused.push(json!({\"p\": target.0, \"q\": target.1, \"why\": why})); continue; }"));
    }
    #[test]
    fn the_32_step_boundary_is_exact() {
        // (review: a route of exactly 32 steps is accepted, 33 is refused; all tiles open over four provinces in a line)
        let path = [(-3, 0), (-2, 0), (-1, 0), (0, 0)];
        let masks: Vec<((i32, i32), u64)> = path.iter().map(|p| (*p, ALL)).collect();
        let pairs = |d: u32| (0..61u8).flat_map(move |a| (0..61u8).map(move |b| (a, b))).find(move |(a, b)| tile_hex(path[0], *a).distance(tile_hex(path[3], *b)) == d);
        let (a32, b32) = pairs(32).expect("a pair 32 apart");
        let r = tile_route((path[0], a32), (path[3], b32), &masks).expect("32 steps: accepted");
        assert_eq!(r.len(), 32);
        let (a33, b33) = pairs(33).expect("a pair 33 apart");
        assert_eq!(tile_route((path[0], a33), (path[3], b33), &masks), None, "33 steps: refused");
    }
    #[test]
    fn the_page_home_choice_is_predicted_by_its_own_order() {
        use frontier_bots::home::hash32;
        let seed = "W|0";
        // innermost ring first; then the province hash; then the lowest site hash in that province
        let provs = vec![((0, 3), vec![1, 2]), ((-2, 0), vec![4, 7, 9]), ((2, 0), vec![3])];
        let (pc, site) = predict_home(&provs, seed).unwrap();
        let ring2: Vec<(i32, i32)> = vec![(-2, 0), (2, 0)];
        let first = *ring2.iter().min_by_key(|(p, q)| hash32(&format!("{seed}|{p},{q}"))).unwrap();
        assert_eq!(pc, first, "a ring-2 province before the ring-3 one, by its hash");
        let sites: &Vec<u8> = &provs.iter().find(|(x, _)| *x == first).unwrap().1;
        assert_eq!(site, *sites.iter().min_by_key(|s| hash32(&format!("{seed}|{},{},{s}", first.0, first.1))).unwrap());
        assert_eq!(predict_home(&[((0, 3), vec![])], seed), None, "no free site: none");
        assert_ne!(predict_home(&provs, "W|0"), None);
    }
    #[test]
    fn a_province_path_reaches_a_bordering_target_within_four_provinces() {
        let t = next_ring_neighbours((-3, 0), 4)[0];
        assert_eq!(province_path((-3, 0), t, 4), Some(vec![(-3, 0)]), "a bordering home: the home alone");
        let far = province_path((-2, 0), t, 4).expect("a ring-2 home reaches through ring 3");
        assert!(far.len() + 1 <= MAX_PATH_PROVINCES && far[0] == (-2, 0));
        for w in far.windows(2) { assert!(province_neighbours(w[0]).contains(&w[1])); }
        assert!(province_neighbours(*far.last().unwrap()).contains(&t));
        assert_eq!(province_path((3, -3), (-4, 4), 4), None, "too far: none");
    }
}
