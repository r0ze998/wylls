//! The NATURAL local-play world (launcher preset `local-natural-v1`): a new Season by its own instructions, then the
//! player's REAL Join and PlaceHome from the page, then the keeper on the home that PlaceHome made.
//!
//! Nothing is written into an account for the player: no Citizen, Holding, home or JoinShard (unlike
//! `expedition_play::Fixture`). The world's own setup is the fresh tests' (`fresh_path` / `fresh_economy_runner`,
//! which stay test-only and untouched): deploy the given artefact, AnnounceSeason → CreateSeason → InitBeaconLogs →
//! InitShards → ConsumeGenesisSeed (the genesis round from the public drand API, BLS-verified) → OpenRing up to the
//! heartland → OpenProvince for every heartland home province. Its clock is SYNTHETIC only before genesis (the
//! chain's fixed g0 is in the past, and the Season needs its 24 h announce lead); from the line `ready-for-join` on it
//! is NATURAL (400 ms slots at 1x) and never moved again.
//!
//! The player's PlaceHome is identified EXACTLY from its landed wire bytes (the builder's PlaceHome for this wallet,
//! the faction and JoinShard its Citizen stores, at a heartland site), and only a successful one counts. The keeper's
//! Holding and home province both come from that one PlaceHome (`natural_home`); any disagreement among the
//! Citizen, Holding and Province stops the runner's keeper start (stated on a line; nothing is sent).
//! No wait has a timeout of its own: the launcher's TTL ends the world.
//!
//! Lines (stdout, one JSON object each): the first is the launcher's metadata (program, rpc_url, season, season_id,
//! player_wallet, artifact, runner_instance, `world: "natural"`); then `{"schema": NATURAL_SCHEMA, "natural_step": …}`
//! steps; then the keeper's own `frontier-local-play-keeper-v1` lines.

use fclient::addr::Addresses;
use fclient::{ix, tx, Address, Keypair, Signer};
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use localnet::server::{lock, Shared};
use permutation_rules::frontier::beacon::{genesis_seed_round, genesis_ts as beacon_genesis_ts, round_time, BeaconClock};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use serde_json::{json, Value};

use crate::expedition_play::{Artifact, PROGRAM, PROGRAM_VERSION, SEASON_ID, PLAYER_LAMPORTS};
use crate::natural_home::{natural_home, NaturalHome};

pub const NATURAL_SCHEMA: &str = "frontier-localnet-natural-play-v1";
/// The launcher's preset name for this world.
pub const PRESET: &str = "local-natural-v1";
/// `t_create_min` relative to the chain's fixed g0: past the program's 24 h announce lead plus one hour (as the fresh tests).
const T_CREATE_MIN_AFTER_G0: i64 = frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + 3_600;
const ADVANCE_SCALE: f64 = 25.0;
const ADVANCE_BLOCK_SECS: i64 = localnet::chain::SLOT_MS as i64 * ADVANCE_SCALE as i64 / 1_000;
const MAX_ADVANCE_SECS: i64 = 2 * 3_600;
const POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// The season parameters: the real S1_LOCAL_7D preset with the deployed program's version.
pub fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
    p.base.program_version = PROGRAM_VERSION;
    p
}

/// (t_create_min, genesis round, genesis_ts), from the preset and the chain's fixed g0 only.
pub fn genesis_plan() -> (i64, u64, i64) {
    let p = params().base;
    let clock = BeaconClock { genesis: p.drand_genesis, period: p.drand_period as i64 };
    let t = localnet::Config::default().g0 + T_CREATE_MIN_AFTER_G0;
    let r = genesis_seed_round(&clock, t, p.seed_margin);
    (t, r, beacon_genesis_ts(&clock, r))
}

// ------------------------------------------------------------------ exact identification (copies of fresh_path's)
/// One instruction of a LANDED transaction, decoded from its wire bytes (only for transactions this node processed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedIx {
    pub program: Address,
    pub metas: Vec<(Address, bool, bool)>,
    pub data: Vec<u8>,
}

pub fn decode_wire(wire: &[u8]) -> Result<Vec<DecodedIx>, String> {
    let t = fclient::tx::from_wire(wire)?;
    let m = &t.message;
    let (n, ns) = (m.account_keys.len(), m.header.num_required_signatures as usize);
    let (ros, rou) = (m.header.num_readonly_signed_accounts as usize, m.header.num_readonly_unsigned_accounts as usize);
    let signer = |i: usize| i < ns;
    let writable = |i: usize| if i < ns { i < ns.saturating_sub(ros) } else { i < n.saturating_sub(rou) };
    m.instructions
        .iter()
        .map(|ci| {
            let program = *m.account_keys.get(ci.program_id_index as usize).ok_or("program index out of range")?;
            let metas = ci
                .accounts
                .iter()
                .map(|&k| m.account_keys.get(k as usize).map(|a| (*a, signer(k as usize), writable(k as usize))).ok_or("account index out of range"))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DecodedIx { program, metas, data: ci.data.clone() })
        })
        .collect()
}

/// The ONE game-program instruction (every other one a compute-budget instruction).
pub fn the_program_ix(ixs: Vec<DecodedIx>) -> Result<DecodedIx, String> {
    let program = Address::new_from_array(PROGRAM);
    let cb = fclient::addr::compute_budget_program();
    let mut found = None;
    for ix in ixs {
        if ix.program == cb {
            continue;
        }
        if ix.program != program {
            return Err(format!("an instruction for another program {}", ix.program));
        }
        if found.replace(ix).is_some() {
            return Err("more than one game-program instruction".into());
        }
    }
    found.ok_or_else(|| "no game-program instruction".to_string())
}

/// True when `got` is exactly the builder's `want` (program, accounts in order with merged privileges, data).
pub fn is_exactly(got: &DecodedIx, want: &fclient::Instruction) -> bool {
    if got.program != want.program_id || got.data != want.data || got.metas.len() != want.accounts.len() {
        return false;
    }
    let merged = |k: &Address| -> (bool, bool) {
        want.accounts.iter().filter(|m| &m.pubkey == k).fold((false, false), |(s, w), m| (s || m.is_signer, w || m.is_writable))
    };
    got.metas.iter().zip(&want.accounts).all(|(g, w)| g.0 == w.pubkey && (g.1, g.2) == merged(&w.pubkey))
}

/// PLACEHOME, exactly, at exactly one of `candidates` (the builder's PlaceHome for this wallet, faction and shard).
pub fn place_home_exact(a: &Addresses, wallet: &Address, faction: u8, shard: u8, candidates: &[(i16, i16, u8)], ix: &DecodedIx) -> Option<(i16, i16, u8)> {
    let player = ix::Player { actor: *wallet, payer: *wallet, wallet: *wallet };
    let hits: Vec<(i16, i16, u8)> = candidates
        .iter()
        .copied()
        .filter(|(p, q, s)| is_exactly(ix, &ix::place_home(a, &player, ix::Site { p: *p, q: *q, site: *s }, faction, shard)))
        .collect();
    (hits.len() == 1).then(|| hits[0])
}

/// The player's faction and JoinShard from its Citizen (after a real Join), or None while it has not joined.
pub fn joined(cd: &[u8], wallet: &Address) -> Option<(u8, u8)> {
    use frontier_abi::v2::layout::player::citizen as C;
    if cd.len() <= C::JOIN_SHARD || cd.get(C::WALLET..C::WALLET + 32) != Some(wallet.to_bytes().as_slice()) || cd[C::FLAGS] & C::FLAG_JOINED == 0 {
        return None;
    }
    Some((cd[C::FACTION], cd[C::JOIN_SHARD]))
}

/// Every site of every heartland home province (the only legal PlaceHome sites of a fresh Season): `(p, q, site)`.
pub fn heartland_sites(homes: &[(i16, i16, u8)], site_count: impl Fn(i16, i16) -> u8, faction: u8) -> Vec<(i16, i16, u8)> {
    homes.iter().filter(|h| h.2 == faction).flat_map(|&(p, q, _)| (0..site_count(p, q)).map(move |s| (p, q, s))).collect()
}

/// The next `Chain::feed` cursor after one page: `feed(after, …)` SKIPS `after` records and a record's `seq` is 1-based
/// (`landed.len() + 1` when it landed), so the record after a page is at index `last.seq`: the next cursor is the
/// last record's seq itself (seq + 1 would skip one, e.g. a PlaceHome landing in the poll after the Join).
pub fn next_cursor(cursor: u64, seqs: &[u64]) -> u64 {
    seqs.last().map_or(cursor, |&s| s.max(cursor))
}

// ------------------------------------------------------------------ the world
fn emit(v: Value) {
    println!("{v}");
}
fn step(name: &str, mut extra: Value) {
    let o = extra.as_object_mut().expect("an object");
    o.insert("schema".into(), json!(NATURAL_SCHEMA));
    o.insert("natural_step".into(), json!(name));
    emit(extra);
}

/// One operator transaction on the paused chain: landed in one explicit block, checked.
fn send(state: &Shared, signers: &[&Keypair], ixs: &[fclient::Instruction], what: &str) -> Result<String, String> {
    let mut c = lock(state);
    let (bh, _) = c.latest_blockhash();
    let budget = tx::TxBudget { cu_limit: 1_400_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: None };
    let t = tx::build(ixs, &budget, signers, &bh).map_err(|e| format!("{what}: build {e}"))?;
    let sig = c.submit(&tx::wire(&t)).map_err(|e| format!("{what} refused before landing: {e}"))?;
    c.produce_block();
    let landed = c.transaction(&sig).cloned().ok_or_else(|| format!("{what} did not land"))?;
    if let Some(err) = landed.err {
        return Err(format!("{what} failed: {err} (code {:?})", landed.code));
    }
    Ok(sig.to_string())
}

/// SYNTHETIC time, before genesis only, in bounded steps of at most 2 h.
fn advance_to(state: &Shared, to: i64) -> Result<(), String> {
    loop {
        let mut c = lock(state);
        let from = c.unix_timestamp();
        if from >= to {
            return Ok(());
        }
        let target = to.min(from + MAX_ADVANCE_SECS - ADVANCE_BLOCK_SECS);
        let restore = c.scale();
        c.set_scale(ADVANCE_SCALE);
        let mut blocks = 0;
        while c.unix_timestamp() < target {
            c.produce_block();
            blocks += 1;
            if blocks > MAX_ADVANCE_SECS / ADVANCE_BLOCK_SECS + 1 {
                c.set_scale(restore);
                return Err("advance block bound".into());
            }
        }
        c.set_scale(restore);
        c.produce_block();
    }
}

fn account(state: &Shared, at: &Address, what: &str) -> Result<Vec<u8>, String> {
    lock(state).account(at).map(|a| a.data).ok_or_else(|| format!("{what} is not there"))
}

/// The prepared natural world: the running node, its addresses and the heartland home provinces.
pub struct World {
    pub running: localnet::server::Running,
    pub state: Shared,
    pub a: Addresses,
    pub homes: Vec<(i16, i16, u8)>,
    pub metadata: Value,
}

/// Builds the world up to `ready-for-join` (the clock then natural). The first line is printed by the caller.
pub async fn prepare(artifact: &Artifact, wallet: Address, rpc_port: u16, ws_port: u16) -> Result<World, String> {
    crate::expedition_play::check_ports(rpc_port, ws_port)?;
    crate::expedition_play::check_wallet(&wallet)?;
    if localnet::bls_and_sbpf_v2_active() != (true, true) {
        return Err("the node's feature set lacks the BLS12-381 syscalls or SBPF v2".into());
    }
    let upgrade = Keypair::new();
    let payer = Keypair::new();
    let program = Address::new_from_array(PROGRAM);
    let a = Addresses::new(program, SEASON_ID);
    let (t_create_min, round, genesis_ts) = genesis_plan();
    let p = params();
    let mut c = localnet::Chain::new(localnet::Config { allow_tamper: false, data_dir: None, ..localnet::Config::default() });
    c.set_paused(true);
    let bytes = std::fs::read(artifact.path()).map_err(|e| format!("artefact: {e}"))?;
    if hex::encode(localnet::persist::sha256(&[&bytes])) != artifact.sha256() {
        return Err("the artefact changed after verification".into());
    }
    c.deploy(program, &bytes, fclient::fees::deploy_max_len(bytes.len() as u64) as usize, Some(upgrade.pubkey()))?;
    c.airdrop(&upgrade.pubkey(), 500_000_000_000)?;
    c.airdrop(&payer.pubkey(), 100_000_000_000)?;
    c.airdrop(&wallet, PLAYER_LAMPORTS)?; // fees and rent only
    c.produce_block();
    let runner_instance = hex::encode(c.status_instance());
    let state: Shared = std::sync::Arc::new(std::sync::Mutex::new(c));
    let running = localnet::server::start_with_policy(state.clone(), rpc_port, ws_port, localnet::server::Policy::MEMORY_ONLY).await?;
    let metadata = json!({"schema": NATURAL_SCHEMA, "world": "natural", "world_preset": PRESET, "runner_instance": runner_instance,
        "rpc_url": running.url(), "program": program.to_string(), "program_version": format!("0x{PROGRAM_VERSION:04x}"),
        "season": a.season.to_string(), "season_id": SEASON_ID, "player_wallet": wallet.to_string(),
        "artifact": {"path": artifact.path().display().to_string(), "sha256": artifact.sha256(), "bytes": bytes.len()},
        "player_airdrop_lamports": PLAYER_LAMPORTS,
        "initial_world": "a new Season by its own instructions (AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards, ConsumeGenesisSeed, OpenRing, OpenProvince); nothing is written into an account for the player",
        "clock": "SYNTHETIC only before genesis (the chain's fixed g0); NATURAL from ready-for-join on, never moved again",
        "memory_only": true});
    let sp = p.to_bytes();
    let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
    send(&state, &[&upgrade], &[ix::announce_season(&a, upgrade.pubkey(), params_hash_v2(&sp, &payout), t_create_min, frontier_abi::presets::MIN_CREATION_BOND)], "AnnounceSeason")?;
    advance_to(&state, t_create_min)?;
    send(&state, &[&upgrade], &[ix::create_season(&a, upgrade.pubkey(), &sp, &payout)], "CreateSeason")?;
    send(&state, &[&upgrade], &[ix::init_beacon_logs(&a, upgrade.pubkey())], "InitBeaconLogs")?;
    for f in 0..fclient::abi::FACTIONS {
        send(&state, &[&upgrade], &[ix::init_shards(&a, upgrade.pubkey(), f)], "InitShards")?;
    }
    let clock = BeaconClock { genesis: p.base.drand_genesis, period: p.base.drand_period as i64 };
    advance_to(&state, round_time(clock.genesis, p.base.drand_period, round) + 1)?;
    let sig48 = crate::local_keeper::fetch_round_at(round).await?; // public drand, BLS-verified
    let arg = ix::BeaconArg { round, sig48, hints: fclient::beacon::hints_bytes(round) };
    send(&state, &[&payer], &[ix::consume_genesis_seed(&a, payer.pubkey(), &arg)], "ConsumeGenesisSeed")?;
    advance_to(&state, genesis_ts + 1)?;
    let sd = account(&state, &a.season, "the Season")?;
    let cq = ConquestParams::of_season(&sd).ok_or("the Season's conquest params")?;
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32].try_into().map_err(|_| "the Season's seed")?;
    let rings_opened = |st: &Shared| -> Result<u16, String> {
        let fd = account(st, &a.frontier(), "the Frontier")?;
        Ok(u16::from_le_bytes(fd[frontier_abi::layout::world::frontier::RINGS_OPENED..][..2].try_into().map_err(|_| "the Frontier")?))
    };
    while rings_opened(&state)? <= cq.heartland_max_ring as u16 {
        let d = rings_opened(&state)?;
        send(&state, &[&payer], &[ix::open_ring(&a, payer.pubkey(), d)], "OpenRing")?;
    }
    let mut homes: Vec<(i16, i16, u8)> = Vec::new();
    for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 != ring {
                    continue;
                }
                if let Some(nation) = home_nation(coord, cq.placement, cq.heartland_max_ring, &seed) {
                    send(&state, &[&payer], &[ix::open_province(&a, payer.pubkey(), pp as i16, qq as i16)], "OpenProvince")?;
                    homes.push((pp as i16, qq as i16, nation));
                }
            }
        }
    }
    Ok(World { running, state, a, homes, metadata })
}

/// After `prepare`: the clock goes natural; waits for the player's successful exact PlaceHome; returns the keeper's
/// Holding and home from it. Stops when `stop` is set.
pub async fn await_home(w: &World, wallet: &Address, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<(NaturalHome, String), String> {
    let program = Address::new_from_array(PROGRAM);
    let citizen = w.a.citizen(wallet);
    let mut cursor = lock(&w.state).transaction_count();
    lock(&w.state).set_paused(false); // NATURAL from here
    step("ready-for-join", json!({"home_provinces": w.homes.iter().map(|(p, q, n)| json!({"p": p.to_string(), "q": q.to_string(), "nation": n})).collect::<Vec<_>>()}));
    let mut said_joined = false;
    loop {
        if *stop.borrow() {
            return Err("stopped by request".into());
        }
        let found = {
            let c = lock(&w.state);
            let ours: Vec<(u64, String, bool, Vec<u8>)> = c
                .feed(cursor, 256, Some(&program))
                .into_iter()
                .map(|l| (l.seq, l.signature.to_string(), l.err.is_none() && l.keys.first() == Some(wallet), l.wire.clone()))
                .collect();
            let cd = c.account(&citizen).map(|a| a.data);
            (ours, cd)
        };
        let (ours, cd) = found;
        cursor = next_cursor(cursor, &ours.iter().map(|o| o.0).collect::<Vec<_>>());
        let Some((faction, shard)) = cd.as_deref().and_then(|d| joined(d, wallet)) else {
            tokio::select! { _ = tokio::time::sleep(POLL) => {} _ = stop.changed() => {} }
            continue;
        };
        if !said_joined {
            said_joined = true;
            step("join-landed", json!({"faction": faction, "shard": shard}));
        }
        let site_count = |p: i16, q: i16| -> u8 {
            use frontier_abi::v2::layout::province::province as PV;
            account(&w.state, &w.a.province(p as i32, q as i32), "a heartland province").ok().and_then(|d| d.get(PV::SITE_COUNT).copied()).unwrap_or(0)
        };
        let candidates = heartland_sites(&w.homes, site_count, faction);
        for (_, sig, ok, wire) in ours.iter().filter(|o| o.2) {
            let Some(at) = decode_wire(wire).ok().and_then(|ixs| the_program_ix(ixs).ok()).and_then(|i| place_home_exact(&w.a, wallet, faction, shard, &candidates, &i)) else {
                continue;
            };
            let _ = ok;
            let holding = w.a.holding(at.0 as i32, at.1 as i32, at.2);
            let home = w.a.province(at.0 as i32, at.1 as i32);
            let cd = account(&w.state, &citizen, "the Citizen")?;
            let hd = account(&w.state, &holding, "the Holding")?;
            let pd = account(&w.state, &home, "the home Province")?;
            let n = natural_home(&w.a, wallet, at, &cd, &hd, &pd)?;
            step("place-home-landed", json!({"signature": sig, "p": at.0.to_string(), "q": at.1.to_string(), "site": at.2, "holding": n.holding.to_string()}));
            return Ok((n, sig.clone()));
        }
        tokio::select! { _ = tokio::time::sleep(POLL) => {} _ = stop.changed() => {} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Chain::feed`'s own rule, modelled: skip `after` records; seqs are 1-based.
    fn feed(all: &[u64], after: u64) -> Vec<u64> {
        all.iter().skip(after as usize).copied().collect()
    }

    #[test]
    fn a_placehome_in_the_poll_after_the_join_is_not_skipped() {
        // records 1..=4 landed before the wait (cursor = transaction_count = 4); the Join lands as 5 (first poll),
        // the PlaceHome as 6 (second poll)
        let mut landed: Vec<u64> = (1..=4).collect();
        let mut cursor = 4u64;
        landed.push(5);
        let page = feed(&landed, cursor);
        assert_eq!(page, vec![5], "the Join");
        cursor = next_cursor(cursor, &page);
        landed.push(6);
        let page = feed(&landed, cursor);
        assert_eq!(page, vec![6], "the PlaceHome of the next poll is seen");
        cursor = next_cursor(cursor, &page);
        assert!(feed(&landed, cursor).is_empty(), "and nothing twice");
        assert_eq!(next_cursor(cursor, &[]), cursor, "an empty page keeps the cursor");
        // seq + 1 (the old rule) would have skipped the PlaceHome
        assert!(feed(&landed, 5 + 1).is_empty());
        // several records in one page: the next page starts after the last
        let all: Vec<u64> = (1..=10).collect();
        let first: Vec<u64> = feed(&all, 2).into_iter().take(3).collect();
        assert_eq!(feed(&all, next_cursor(2, &first))[0], 6);
    }

    #[test]
    fn heartland_sites_are_the_factions_home_provinces_sites_only() {
        let homes = [(2, 0, 1u8), (1, 1, 0), (-2, 1, 1)];
        let got = heartland_sites(&homes, |p, _| if p == 2 { 2 } else { 3 }, 1);
        assert_eq!(got, vec![(2, 0, 0), (2, 0, 1), (-2, 1, 0), (-2, 1, 1), (-2, 1, 2)]);
        assert!(heartland_sites(&homes, |_, _| 3, 5).is_empty());
    }

    #[test]
    fn joined_needs_this_wallet_and_the_joined_flag() {
        use frontier_abi::v2::layout::player::citizen as C;
        let w = Address::new_from_array([7; 32]);
        let mut cd = vec![0u8; C::SIZE];
        assert_eq!(joined(&cd, &w), None);
        cd[C::WALLET..C::WALLET + 32].copy_from_slice(&w.to_bytes());
        assert_eq!(joined(&cd, &w), None, "not joined");
        cd[C::FLAGS] = C::FLAG_JOINED;
        cd[C::FACTION] = 3;
        cd[C::JOIN_SHARD] = 5;
        assert_eq!(joined(&cd, &w), Some((3, 5)));
        assert_eq!(joined(&cd, &Address::new_from_array([8; 32])), None, "another wallet");
        assert_eq!(joined(&cd[..10], &w), None, "short");
    }

    #[test]
    fn a_placehome_is_identified_exactly_at_one_candidate() {
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let w = Address::new_from_array([7; 32]);
        let player = ix::Player { actor: w, payer: w, wallet: w };
        let want = ix::place_home(&a, &player, ix::Site { p: 2, q: 0, site: 1 }, 1, 4);
        // as a compiled message grants them: a key listed twice (actor = payer = wallet) gets the union of its privileges
        let merged = |k: &Address| want.accounts.iter().filter(|m| &m.pubkey == k).fold((false, false), |(s, w), m| (s || m.is_signer, w || m.is_writable));
        let dec = DecodedIx { program: want.program_id, metas: want.accounts.iter().map(|m| { let (s, w) = merged(&m.pubkey); (m.pubkey, s, w) }).collect(), data: want.data.clone() };
        let cands = [(2, 0, 0), (2, 0, 1), (2, 0, 2)];
        assert_eq!(place_home_exact(&a, &w, 1, 4, &cands, &dec), Some((2, 0, 1)));
        assert_eq!(place_home_exact(&a, &w, 1, 4, &[(2, 0, 0)], &dec), None, "not a candidate");
        assert_eq!(place_home_exact(&a, &w, 2, 4, &cands, &dec), None, "another faction");
        assert_eq!(place_home_exact(&a, &w, 1, 3, &cands, &dec), None, "another shard");
        assert_eq!(place_home_exact(&a, &Address::new_from_array([8; 32]), 1, 4, &cands, &dec), None, "another wallet");
        let mut other = dec.clone();
        other.data.push(0);
        assert_eq!(place_home_exact(&a, &w, 1, 4, &cands, &other), None, "other data");
    }
}
