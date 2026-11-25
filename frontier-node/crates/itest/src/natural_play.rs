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
use frontier_abi::v2::presets::{
    params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D, S1_LOCAL_CONTINUOUS,
};
use localnet::server::{lock, Shared};
use permutation_rules::frontier::beacon::{
    genesis_seed_round, genesis_ts as beacon_genesis_ts, round_time, BeaconClock,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use serde_json::{json, Value};

use crate::expedition_play::{Artifact, PLAYER_LAMPORTS, PROGRAM, PROGRAM_VERSION, SEASON_ID};
use crate::natural_home::{natural_home, NaturalHome};
use crate::natural_persist::{self as persist, NaturalOptions, Opened, RunDir, WorldRecord};

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
    params_for(false)
}

/// [`params`], or with `continuous` the real `S1_LOCAL_CONTINUOUS` preset (the same parameters, no end bell, joins
/// always open; TEST-ONLY option `--continuous local-continuous-v1`), with the deployed program's version.
pub fn params_for(continuous: bool) -> SeasonParamsV2 {
    // (TEST-ONLY local rules: the centre free, ⑭ R2; `wide_play::local_free`. The presets are unchanged.)
    let mut p = crate::wide_play::local_free(if continuous {
        S1_LOCAL_CONTINUOUS
    } else {
        S1_LOCAL_7D
    });
    p.base.program_version = PROGRAM_VERSION;
    p
}

/// (t_create_min, genesis round, genesis_ts), from the preset and the chain's fixed g0 only: EVERY world made this
/// way consumes the same genesis round, so the program derives the same genesis seed and the same map.
pub fn genesis_plan() -> (i64, u64, i64) {
    genesis_plan_at(localnet::Config::default().g0)
}

/// [`genesis_plan`] for a chain whose clock origin is `g0` (TEST-ONLY `--map-origin`: another origin fixes another
/// genesis round, and the program's unchanged rules derive another genesis seed from that round's signature).
pub fn genesis_plan_at(g0: i64) -> (i64, u64, i64) {
    let p = params().base;
    let clock = BeaconClock {
        genesis: p.drand_genesis,
        period: p.drand_period as i64,
    };
    let t = g0 + T_CREATE_MIN_AFTER_G0;
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
    let (n, ns) = (
        m.account_keys.len(),
        m.header.num_required_signatures as usize,
    );
    let (ros, rou) = (
        m.header.num_readonly_signed_accounts as usize,
        m.header.num_readonly_unsigned_accounts as usize,
    );
    let signer = |i: usize| i < ns;
    let writable = |i: usize| {
        if i < ns {
            i < ns.saturating_sub(ros)
        } else {
            i < n.saturating_sub(rou)
        }
    };
    m.instructions
        .iter()
        .map(|ci| {
            let program = *m
                .account_keys
                .get(ci.program_id_index as usize)
                .ok_or("program index out of range")?;
            let metas = ci
                .accounts
                .iter()
                .map(|&k| {
                    m.account_keys
                        .get(k as usize)
                        .map(|a| (*a, signer(k as usize), writable(k as usize)))
                        .ok_or("account index out of range")
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DecodedIx {
                program,
                metas,
                data: ci.data.clone(),
            })
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
    if got.program != want.program_id
        || got.data != want.data
        || got.metas.len() != want.accounts.len()
    {
        return false;
    }
    let merged = |k: &Address| -> (bool, bool) {
        want.accounts
            .iter()
            .filter(|m| &m.pubkey == k)
            .fold((false, false), |(s, w), m| {
                (s || m.is_signer, w || m.is_writable)
            })
    };
    got.metas
        .iter()
        .zip(&want.accounts)
        .all(|(g, w)| g.0 == w.pubkey && (g.1, g.2) == merged(&w.pubkey))
}

/// PLACEHOME, exactly, at exactly one of `candidates` (the builder's PlaceHome for this wallet, faction and shard).
pub fn place_home_exact(
    a: &Addresses,
    wallet: &Address,
    faction: u8,
    shard: u8,
    candidates: &[(i16, i16, u8)],
    ix: &DecodedIx,
) -> Option<(i16, i16, u8)> {
    let player = ix::Player {
        actor: *wallet,
        payer: *wallet,
        wallet: *wallet,
    };
    let hits: Vec<(i16, i16, u8)> = candidates
        .iter()
        .copied()
        .filter(|(p, q, s)| {
            is_exactly(
                ix,
                &ix::place_home(
                    a,
                    &player,
                    ix::Site {
                        p: *p,
                        q: *q,
                        site: *s,
                    },
                    faction,
                    shard,
                ),
            )
        })
        .collect();
    (hits.len() == 1).then(|| hits[0])
}

/// The player's faction and JoinShard from its Citizen (after a real Join), or None while it has not joined.
pub fn joined(cd: &[u8], wallet: &Address) -> Option<(u8, u8)> {
    use frontier_abi::v2::layout::player::citizen as C;
    if cd.len() <= C::JOIN_SHARD
        || cd.get(C::WALLET..C::WALLET + 32) != Some(wallet.to_bytes().as_slice())
        || cd[C::FLAGS] & C::FLAG_JOINED == 0
    {
        return None;
    }
    Some((cd[C::FACTION], cd[C::JOIN_SHARD]))
}

/// Every site of every heartland home province (the only legal PlaceHome sites of a fresh Season): `(p, q, site)`.
pub fn heartland_sites(
    homes: &[(i16, i16, u8)],
    site_count: impl Fn(i16, i16) -> u8,
    faction: u8,
) -> Vec<(i16, i16, u8)> {
    homes
        .iter()
        .filter(|h| h.2 == faction)
        .flat_map(|&(p, q, _)| (0..site_count(p, q)).map(move |s| (p, q, s)))
        .collect()
}

/// (TEST-ONLY wide play) The player's slot-1 village when it stands on one of `homes` past the heartland (ring > 3: a
/// settled rim province the wide world lists) and the program wrote it: the Citizen's slot 1 names it with a gen, the
/// legacy Holding there is this Citizen's at that site. `None` otherwise (also for every heartland home: those are
/// identified by their exact PlaceHome).
pub fn ticket_home(
    a: &Addresses,
    wallet: &Address,
    homes: &[(i16, i16, u8)],
    citizen: &[u8],
    read: impl Fn(&Address) -> Option<Vec<u8>>,
) -> Option<NaturalHome> {
    use frontier_abi::v2::layout::player::holding as H;
    let c = fclient::decode::Citizen::decode(citizen).ok()?;
    if c.wallet != *wallet {
        return None;
    }
    let s = c.holding[0];
    if s.gen == 0xFF
        || !homes.iter().any(|h| (h.0, h.1) == (s.p, s.q))
        || ProvinceCoord::new(s.p as i32, s.q as i32).ring() <= 6
    {
        return None;
    }
    let holding = a.holding(s.p as i32, s.q as i32, s.site);
    let hd = read(&holding)?;
    if hd.get(..8) != Some(b"PSF1HOLD".as_slice())
        || hd.get(H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32)
            != Some(a.citizen(wallet).to_bytes().as_slice())
    {
        return None;
    }
    Some(NaturalHome {
        holding,
        home: (s.p, s.q),
        site: s.site,
        gen: s.gen,
    })
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
fn send(
    state: &Shared,
    signers: &[&Keypair],
    ixs: &[fclient::Instruction],
    what: &str,
) -> Result<String, String> {
    let mut c = lock(state);
    let (bh, _) = c.latest_blockhash();
    let budget = tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: None,
    };
    let t = tx::build(ixs, &budget, signers, &bh).map_err(|e| format!("{what}: build {e}"))?;
    let sig = c
        .submit(&tx::wire(&t))
        .map_err(|e| format!("{what} refused before landing: {e}"))?;
    c.produce_block();
    let landed = c
        .transaction(&sig)
        .cloned()
        .ok_or_else(|| format!("{what} did not land"))?;
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
    lock(state)
        .account(at)
        .map(|a| a.data)
        .ok_or_else(|| format!("{what} is not there"))
}

/// The prepared natural world: the running node, its addresses and the heartland home provinces.
pub struct World {
    pub running: localnet::server::Running,
    pub state: Shared,
    pub a: Addresses,
    pub homes: Vec<(i16, i16, u8)>,
    pub metadata: Value,
    /// Re-opened from its run dir's ledger (`--persist-dir`): the player's Join and PlaceHome are looked for in the
    /// whole recovered history, not only after the start.
    pub resumed: bool,
}

/// Every heartland home province of a Season (`(p, q, nation)`, the order `prepare` opens them in): rings
/// `2..=heartland_max_ring`, each province whose `home_nation` the placement gives.
pub fn home_provinces(cq: &ConquestParams, seed: &[u8; 32]) -> Vec<(i16, i16, u8)> {
    let mut homes = Vec::new();
    for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 != ring {
                    continue;
                }
                if let Some(nation) = home_nation(coord, cq.placement, cq.heartland_max_ring, seed)
                {
                    homes.push((pp as i16, qq as i16, nation));
                }
            }
        }
    }
    homes
}

/// Builds the world up to `ready-for-join` (the clock then natural). The first line is printed by the caller.
pub async fn prepare(
    artifact: &Artifact,
    wallet: Address,
    rpc_port: u16,
    ws_port: u16,
) -> Result<World, String> {
    prepare_with(
        artifact,
        wallet,
        rpc_port,
        ws_port,
        &NaturalOptions::default(),
    )
    .await
}

/// [`prepare`] with the TEST-ONLY options (`natural_persist`): the continuous preset, and a private run dir whose
/// world is created there, or resumed from its own ledger when it already holds one.
pub async fn prepare_with(
    artifact: &Artifact,
    wallet: Address,
    rpc_port: u16,
    ws_port: u16,
    o: &NaturalOptions,
) -> Result<World, String> {
    crate::expedition_play::check_ports(rpc_port, ws_port)?;
    crate::expedition_play::check_wallet(&wallet)?;
    if localnet::bls_and_sbpf_v2_active() != (true, true) {
        return Err("the node's feature set lacks the BLS12-381 syscalls or SBPF v2".into());
    }
    let run = o.persist.as_deref().map(RunDir::open).transpose()?;
    let opened = run
        .as_ref()
        .map(|r| r.start(&wallet, artifact.sha256(), o.continuous))
        .transpose()?;
    let (upgrade, payer, resume) = match opened {
        None => (Keypair::new(), Keypair::new(), None),
        Some(Opened::Fresh { upgrade, payer }) => (upgrade, payer, None),
        Some(Opened::Resume {
            record,
            upgrade,
            payer,
        }) => (upgrade, payer, Some(record)),
    };
    let program = Address::new_from_array(PROGRAM);
    let a = Addresses::new(program, SEASON_ID);
    // (TEST-ONLY `--map-origin`: a NEW world's clock origin; a resumed chain keeps its ledger's own)
    let g0 = o.map_origin.unwrap_or(localnet::Config::default().g0);
    let (t_create_min, round, genesis_ts) = genesis_plan_at(g0);
    if o.wide && (o.continuous || o.persist.is_some()) {
        return Err(
            "--wide-land is a memory-only finite world: not with --continuous or --persist-dir"
                .into(),
        );
    }
    let p = if o.wide {
        crate::wide_land::params()
    } else {
        params_for(o.continuous)
    };
    let fresh_record = |done: bool| WorldRecord {
        wallet,
        artifact_sha256: artifact.sha256().to_owned(),
        continuous: o.continuous,
        program,
        season: a.season,
        season_id: SEASON_ID,
        upgrade: upgrade.pubkey(),
        payer: payer.pubkey(),
        setup_complete: done,
    };
    if let (Some(r), None) = (&run, &resume) {
        r.record(&fresh_record(false))?;
    }
    let mut c = localnet::Chain::open(localnet::Config {
        allow_tamper: false,
        data_dir: run.as_ref().map(RunDir::chain_dir),
        keep_snapshots: 2,
        g0,
        ..localnet::Config::default()
    })
    .map_err(|e| format!("the chain: {e}"))?;
    c.set_paused(true);
    let bytes = std::fs::read(artifact.path()).map_err(|e| format!("artefact: {e}"))?;
    if hex::encode(localnet::persist::sha256(&[&bytes])) != artifact.sha256() {
        return Err("the artefact changed after verification".into());
    }
    if let Some(record) = &resume {
        return resume_world(
            c,
            record,
            &a,
            wallet,
            rpc_port,
            ws_port,
            artifact,
            bytes.len(),
            o,
        )
        .await;
    }
    c.deploy(
        program,
        &bytes,
        fclient::fees::deploy_max_len(bytes.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )?;
    c.airdrop(&upgrade.pubkey(), 500_000_000_000)?;
    c.airdrop(&payer.pubkey(), 100_000_000_000)?;
    c.airdrop(&wallet, PLAYER_LAMPORTS)?; // fees and rent only
    c.produce_block();
    let runner_instance = hex::encode(c.status_instance());
    let state: Shared = std::sync::Arc::new(std::sync::Mutex::new(c));
    let running = localnet::server::start_with_policy(
        state.clone(),
        rpc_port,
        ws_port,
        localnet::server::Policy::MEMORY_ONLY.with_control_from_env(),
    )
    .await?;
    let mut metadata = json!({"schema": NATURAL_SCHEMA, "world": "natural", "world_preset": PRESET, "runner_instance": runner_instance,
        "rpc_url": running.url(), "program": program.to_string(), "program_version": format!("0x{PROGRAM_VERSION:04x}"),
        "season": a.season.to_string(), "season_id": SEASON_ID, "player_wallet": wallet.to_string(),
        "artifact": {"path": artifact.path().display().to_string(), "sha256": artifact.sha256(), "bytes": bytes.len()},
        "player_airdrop_lamports": PLAYER_LAMPORTS,
        "initial_world": "a new Season by its own instructions (AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards, ConsumeGenesisSeed, OpenRing, OpenProvince); nothing is written into an account for the player",
        "clock": "SYNTHETIC only before genesis (the chain's fixed g0); NATURAL from ready-for-join on, never moved again",
        "memory_only": run.is_none()});
    world_metadata(&mut metadata, o, false);
    map_metadata(&mut metadata, g0);
    let sp = p.to_bytes();
    let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
    send(
        &state,
        &[&upgrade],
        &[ix::announce_season(
            &a,
            upgrade.pubkey(),
            params_hash_v2(&sp, &payout),
            t_create_min,
            frontier_abi::presets::MIN_CREATION_BOND,
        )],
        "AnnounceSeason",
    )?;
    advance_to(&state, t_create_min)?;
    send(
        &state,
        &[&upgrade],
        &[ix::create_season(&a, upgrade.pubkey(), &sp, &payout)],
        "CreateSeason",
    )?;
    send(
        &state,
        &[&upgrade],
        &[ix::init_beacon_logs(&a, upgrade.pubkey())],
        "InitBeaconLogs",
    )?;
    for f in 0..fclient::abi::FACTIONS {
        send(
            &state,
            &[&upgrade],
            &[ix::init_shards(&a, upgrade.pubkey(), f)],
            "InitShards",
        )?;
    }
    let clock = BeaconClock {
        genesis: p.base.drand_genesis,
        period: p.base.drand_period as i64,
    };
    advance_to(
        &state,
        round_time(clock.genesis, p.base.drand_period, round) + 1,
    )?;
    let sig48 = crate::local_keeper::fetch_round_at(round).await?; // public drand, BLS-verified
    let arg = ix::BeaconArg {
        round,
        sig48,
        hints: fclient::beacon::hints_bytes(round),
    };
    send(
        &state,
        &[&payer],
        &[ix::consume_genesis_seed(&a, payer.pubkey(), &arg)],
        "ConsumeGenesisSeed",
    )?;
    advance_to(&state, genesis_ts + 1)?;
    let sd = account(&state, &a.season, "the Season")?;
    let cq = ConquestParams::of_season(&sd).ok_or("the Season's conquest params")?;
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .map_err(|_| "the Season's seed")?;
    let rings_opened = |st: &Shared| -> Result<u16, String> {
        let fd = account(st, &a.frontier(), "the Frontier")?;
        Ok(u16::from_le_bytes(
            fd[frontier_abi::layout::world::frontier::RINGS_OPENED..][..2]
                .try_into()
                .map_err(|_| "the Frontier")?,
        ))
    };
    while rings_opened(&state)? <= cq.heartland_max_ring as u16 {
        let d = rings_opened(&state)?;
        send(
            &state,
            &[&payer],
            &[ix::open_ring(&a, payer.pubkey(), d)],
            "OpenRing",
        )?;
    }
    let homes = home_provinces(&cq, &seed);
    // (the TEST-ONLY wide land opens the heartland itself: most of it after the growth, so it starts resolved to now)
    for &(pp, qq, _) in homes.iter().filter(|_| !o.wide) {
        send(
            &state,
            &[&payer],
            &[ix::open_province(&a, payer.pubkey(), pp, qq)],
            "OpenProvince",
        )?;
    }
    // (TEST-ONLY wide land: the map grown to the rim and into the wide land, still on the synthetic clock; its rim
    //  homes are PlaceHome targets as the heartland's are)
    let mut homes = homes;
    if o.wide {
        let (summary, rim) =
            crate::wide_land::grow(&state, &a, &upgrade, &payer, &homes, send, advance_to).await?;
        crate::wide_land::wide_metadata(&mut metadata, &summary);
        // (TEST-ONLY research, world goal ②, owner 2026-11-25 08:56: started by the Season authority at the bell the
        //  growth left the clock on — before any player or resident joins, so every nation starts from 0 science at
        //  the same bell, Q-RS-3 (b); the crank is `wide_research::run`. Not bell 0: the growth's synthetic clock is
        //  past it by now and the program refuses a start bell in the past — verify-pr232)
        let start_bell = {
            let c = lock(&state);
            let clock = crate::local_keeper::season_clock(&c, &a)?;
            clock.bell_at(c.unix_timestamp()).unwrap_or(0)
        };
        send(
            &state,
            &[&upgrade],
            &[crate::wide_research::start_ix(&a, upgrade.pubkey(), start_bell)],
            "WideStartResearch",
        )?;
        homes.extend(rim);
    }
    // (TEST-ONLY local rules: the centre free; its ring-1 provinces opened, never PlaceHome targets: the program's
    //  first homes stay at ring 2+)
    let centre = crate::wide_play::centre_provinces(&cq, &seed);
    for &(pp, qq, _) in &centre {
        send(
            &state,
            &[&payer],
            &[ix::open_province(&a, payer.pubkey(), pp, qq)],
            "OpenProvince (centre)",
        )?;
    }
    metadata
        .as_object_mut()
        .expect("an object")
        .insert("local_rules".into(), {
            let mut v = crate::wide_play::rules_metadata(
                if o.wide {
                    "S1_DEVNET_WIDE_7D"
                } else if o.continuous {
                    "S1_LOCAL_CONTINUOUS"
                } else {
                    "S1_LOCAL_7D"
                },
                o.wide,
            );
            v["centre_provinces"] = json!(centre
                .iter()
                .map(|(p, q, n)| json!({"p": p, "q": q, "nation": n}))
                .collect::<Vec<_>>());
            v
        });
    if let Some(r) = &run {
        r.record(&fresh_record(true))?;
    }
    Ok(World {
        running,
        state,
        a,
        homes,
        metadata,
        resumed: false,
    })
}

/// The TEST-ONLY options on the runner's first line: `continuous` always; `persist` with a run dir.
fn world_metadata(m: &mut Value, o: &NaturalOptions, resumed: bool) {
    let obj = m.as_object_mut().expect("an object");
    obj.insert("continuous".into(), json!(o.continuous));
    if o.continuous {
        obj.insert("continuous_mode".into(), json!(persist::CONTINUOUS_MODE));
    }
    if o.persist.is_some() {
        obj.insert(
            "persist".into(),
            json!({"mode": persist::PERSIST_MODE, "resumed": resumed, "test_only": true, "not_for_production": true}),
        );
    }
}

/// The TEST-ONLY fresh map on the runner's first line: stated only by a world whose chain clock origin is not the fixed
/// one (`--map-origin` at its first start), with that origin and the genesis round it fixes.
fn map_metadata(m: &mut Value, g0: i64) {
    if g0 != localnet::Config::default().g0 {
        m.as_object_mut().expect("an object").insert(
            "fresh_map".into(),
            json!({"mode": persist::FRESH_MAP_MODE, "origin": g0, "genesis_round": genesis_plan_at(g0).1, "test_only": true}),
        );
    }
}

/// A world re-opened from its run dir: nothing is deployed, funded or sent; the recovered Season must be the
/// recorded one (`natural_persist::check_resumed_season`); the home provinces are those the Season's own seed and
/// parameters give (as `prepare` opened them).
#[allow(clippy::too_many_arguments)]
async fn resume_world(
    c: localnet::Chain,
    record: &WorldRecord,
    a: &Addresses,
    wallet: Address,
    rpc_port: u16,
    ws_port: u16,
    artifact: &Artifact,
    artifact_len: usize,
    o: &NaturalOptions,
) -> Result<World, String> {
    let program = Address::new_from_array(PROGRAM);
    if record.program != program || record.season != a.season || record.season_id != SEASON_ID {
        return Err("this run dir's world is of another program or Season; refusing".into());
    }
    if !c.account(&program).is_some_and(|acc| acc.executable) {
        return Err("the resumed chain has no deployed program; refusing".into());
    }
    let sd = c
        .account(&a.season)
        .map(|acc| acc.data)
        .ok_or("the resumed chain has no Season; refusing")?;
    persist::check_resumed_season(&sd, record)?;
    let cq = ConquestParams::of_season(&sd).ok_or("the Season's conquest params")?;
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .map_err(|_| "the Season's seed")?;
    let homes = home_provinces(&cq, &seed);
    for &(pp, qq, _) in &homes {
        if c.account(&a.province(pp as i32, qq as i32)).is_none() {
            return Err("a heartland province is missing on the resumed chain; refusing".into());
        }
    }
    let runner_instance = hex::encode(c.status_instance());
    let slot = c.slot();
    let g0 = c.config().g0; // (the ledger's own origin: a `--map-origin` of this start changes nothing)
    let state: Shared = std::sync::Arc::new(std::sync::Mutex::new(c));
    let running = localnet::server::start_with_policy(
        state.clone(),
        rpc_port,
        ws_port,
        localnet::server::Policy::MEMORY_ONLY.with_control_from_env(),
    )
    .await?;
    let mut metadata = json!({"schema": NATURAL_SCHEMA, "world": "natural", "world_preset": PRESET, "runner_instance": runner_instance,
        "rpc_url": running.url(), "program": program.to_string(), "program_version": format!("0x{PROGRAM_VERSION:04x}"),
        "season": a.season.to_string(), "season_id": SEASON_ID, "player_wallet": wallet.to_string(),
        "artifact": {"path": artifact.path().display().to_string(), "sha256": artifact.sha256(), "bytes": artifact_len},
        "player_airdrop_lamports": PLAYER_LAMPORTS,
        "initial_world": "RESUMED: the same chain, re-opened from its own ledger (every re-executed transaction repeated its recorded outcome); nothing was deployed, funded or sent at this start",
        "resumed_at_slot": slot,
        "clock": "NATURAL; it stood still while the world was stopped and continues from the game time of its last record",
        "memory_only": false});
    world_metadata(&mut metadata, o, true);
    map_metadata(&mut metadata, g0);
    Ok(World {
        running,
        state,
        a: a.clone(),
        homes,
        metadata,
        resumed: true,
    })
}

/// After `prepare`: the clock goes natural; waits for the player's successful exact PlaceHome; returns the keeper's
/// Holding and home from it. Stops when `stop` is set.
pub async fn await_home(
    w: &World,
    wallet: &Address,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(NaturalHome, String), String> {
    let program = Address::new_from_array(PROGRAM);
    let citizen = w.a.citizen(wallet);
    // (a resumed world: the Join and PlaceHome may be in the recovered history, so it is read from its start)
    let mut cursor = if w.resumed {
        0
    } else {
        lock(&w.state).transaction_count()
    };
    lock(&w.state).set_paused(false); // NATURAL from here
    step(
        "ready-for-join",
        json!({"home_provinces": w.homes.iter().map(|(p, q, n)| json!({"p": p.to_string(), "q": q.to_string(), "nation": n})).collect::<Vec<_>>()}),
    );
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
                .map(|l| {
                    (
                        l.seq,
                        l.signature.to_string(),
                        l.err.is_none() && l.keys.first() == Some(wallet),
                        l.wire.clone(),
                    )
                })
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
            account(
                &w.state,
                &w.a.province(p as i32, q as i32),
                "a heartland province",
            )
            .ok()
            .and_then(|d| d.get(PV::SITE_COUNT).copied())
            .unwrap_or(0)
        };
        let candidates = heartland_sites(&w.homes, site_count, faction);
        // (TEST-ONLY wide play: a first home on the rim comes by the legacy ticket — PlaceHome cannot name a province past
        //  the Season's base r_max — settled by the runner's own duty (`wide_play::run_claims`): the keeper starts on
        //  the Citizen's slot-1 village once the program has written it, provisional or final, at a listed rim home)
        if let Some(n) = cd.as_deref().and_then(|d| {
            ticket_home(&w.a, wallet, &w.homes, d, |k| {
                account(&w.state, k, "a home account").ok()
            })
        }) {
            step(
                "ticket-home-landed",
                json!({"p": n.home.0.to_string(), "q": n.home.1.to_string(), "site": n.site, "holding": n.holding.to_string(), "test_only": true}),
            );
            return Ok((n, String::new()));
        }
        for (_, sig, ok, wire) in ours.iter().filter(|o| o.2) {
            let Some(at) = decode_wire(wire)
                .ok()
                .and_then(|ixs| the_program_ix(ixs).ok())
                .and_then(|i| place_home_exact(&w.a, wallet, faction, shard, &candidates, &i))
            else {
                continue;
            };
            let _ = ok;
            let holding = w.a.holding(at.0 as i32, at.1 as i32, at.2);
            let home = w.a.province(at.0 as i32, at.1 as i32);
            let cd = account(&w.state, &citizen, "the Citizen")?;
            let hd = account(&w.state, &holding, "the Holding")?;
            let pd = account(&w.state, &home, "the home Province")?;
            let n = natural_home(&w.a, wallet, at, &cd, &hd, &pd)?;
            step(
                "place-home-landed",
                json!({"signature": sig, "p": at.0.to_string(), "q": at.1.to_string(), "site": at.2, "holding": n.holding.to_string()}),
            );
            return Ok((n, sig.clone()));
        }
        tokio::select! { _ = tokio::time::sleep(POLL) => {} _ = stop.changed() => {} }
    }
}

/// ⑧ P2 (TEST-ONLY): a natural world in a private run dir is stopped and RESUMED from its own ledger: the same Season,
/// the player's Citizen and Holding byte for byte, the same home found again in the recovered history; another wallet
/// or the other continuous word is refused. `#[ignore]` and approval-gated like the other real natural-world tests:
/// it builds a Season by its own instructions (the genesis round from the public drand API, BLS-verified) on loopback
/// ports 41380/41381, and signs the player's Join and PlaceHome with a fresh in-memory TEST key.
///   WYLLS_PUBLIC_DRAND=1 WYLLS_EXPEDITION_SBF=<abs .so> WYLLS_EXPEDITION_SBF_SHA256=<hex> \
///   cargo test -p itest --features localnet-expedition-play --lib natural_play::resume -- --ignored
#[cfg(test)]
mod resume {
    use super::*;

    /// The gap t363u names, and the TEST-ONLY way out: with the fixed origin every world fixes the SAME genesis
    /// round (pinned here), so the program derives the same seed and the same map; another origin fixes another
    /// round, by the kernel's own `genesis_seed_round` (no rule is changed).
    #[test]
    fn the_fixed_origin_fixes_one_genesis_round_and_another_origin_another() {
        let g0 = localnet::Config::default().g0;
        assert_eq!(genesis_plan(), genesis_plan_at(g0));
        assert_eq!(genesis_plan(), (1_785_632_400, 30_943_232, 1_785_633_660));
        let lo = g0 - persist::MAP_ORIGIN_SPAN_SECS;
        let mut rounds = std::collections::BTreeSet::new();
        for o in [lo, lo + 3, g0 - 86_400, g0 - 3, g0] {
            assert_eq!(persist::map_origin_ok(o), o != g0);
            let (t, r, ts) = genesis_plan_at(o);
            assert_eq!(t, o + T_CREATE_MIN_AFTER_G0);
            assert!(ts > t && r < genesis_plan().1 || o == g0);
            assert!(r > 0);
            rounds.insert(r);
        }
        assert_eq!(rounds.len(), 5, "each origin fixes its own round");
        // (stated on the first line only by a world of another origin)
        let mut m = json!({});
        map_metadata(&mut m, g0);
        assert_eq!(m, json!({}));
        map_metadata(&mut m, g0 - 3);
        assert_eq!(
            m["fresh_map"],
            json!({"mode": "local-fresh-map-v1", "origin": g0 - 3, "genesis_round": 30_943_231u64, "test_only": true})
        );
    }
    use crate::keeper_loop::submit_and_wait;
    use std::time::Duration;

    fn rx() -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        std::mem::forget(tx);
        rx
    }

    #[test]
    #[ignore]
    fn a_stopped_continuous_world_resumes_with_the_same_village() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let art = crate::expedition_play::inspect(
            path.clone(),
            std::fs::read(&path).unwrap(),
            &need("WYLLS_EXPEDITION_SBF_SHA256"),
        )
        .unwrap();
        let dir = std::env::temp_dir().join(format!("psf-natural-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let o = NaturalOptions {
            continuous: true,
            persist: Some(dir.clone()),
            map_origin: None,
            wide: false,
        };
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let player = Keypair::new();
        let w = player.pubkey();
        let (a, home, before) = rt.block_on(async {
            let world = prepare_with(&art, w, 41_380, 41_381, &o)
                .await
                .expect("the world");
            assert!(!world.resumed);
            assert_eq!(world.metadata["continuous"], true);
            assert_eq!(world.metadata["persist"]["resumed"], false);
            assert_eq!(world.metadata["memory_only"], false);
            let (state, a) = (world.state.clone(), world.a.clone());
            lock(&state).set_paused(false);
            let send = |ix, what: &'static str| {
                let (state, player) = (state.clone(), player.insecure_clone());
                async move {
                    match submit_and_wait(
                        &state,
                        &player,
                        ix,
                        what,
                        Duration::from_secs(60),
                        &mut rx(),
                    )
                    .await
                    {
                        crate::keeper_loop::Sent::Landed(sig) => sig,
                        other => panic!("{what}: {other:?}"),
                    }
                }
            };
            let now = lock(&state).unix_timestamp();
            send(
                ix::join(&a, w, w, world.homes[0].2, &w, now + 3_600, None),
                "Join",
            )
            .await;
            let (faction, shard) =
                joined(&account(&state, &a.citizen(&w), "c").unwrap(), &w).expect("joined");
            let site = {
                use frontier_abi::v2::layout::province::{province as PV, site as SM};
                world
                    .homes
                    .iter()
                    .filter(|h| h.2 == faction)
                    .find_map(|(pp, qq, _)| {
                        let pd = account(&state, &a.province(*pp as i32, *qq as i32), "p").unwrap();
                        (0..pd[PV::SITE_COUNT] as usize)
                            .find(|i| {
                                matches!(
                                    pd[PV::site(*i) + SM::STATE],
                                    SM::STATE_FREE | SM::STATE_RELEASED_FREE
                                )
                            })
                            .map(|i| (*pp, *qq, i as u8))
                    })
                    .expect("a free heartland site")
            };
            let me = ix::Player {
                actor: w,
                payer: w,
                wallet: w,
            };
            send(
                ix::place_home(
                    &a,
                    &me,
                    ix::Site {
                        p: site.0,
                        q: site.1,
                        site: site.2,
                    },
                    faction,
                    shard,
                ),
                "PlaceHome",
            )
            .await;
            let holding = a.holding(site.0 as i32, site.1 as i32, site.2);
            let home = (holding, (site.0, site.1));
            let before =
                [a.season, a.citizen(&w), holding].map(|k| account(&state, &k, "b").unwrap());
            // (the world stops: its server ends and the chain, with its ledger writer, is dropped)
            let World { running, state, .. } = world;
            running.stop();
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(state);
            (a, home, before)
        });
        // the ledger and the keys are there, private
        assert!(dir.join("chain").join(localnet::persist::WAL_FILE).exists());
        crate::natural_persist::check_private(&dir.join("keys/upgrade.seed"), false, "k").unwrap();
        rt.block_on(async {
            // another wallet, or the finite word: refused before anything starts
            let other = NaturalOptions {
                continuous: false,
                persist: Some(dir.clone()),
                map_origin: None,
                wide: false,
            };
            assert!(prepare_with(&art, w, 41_380, 41_381, &other)
                .await
                .err()
                .unwrap()
                .contains("continuous"));
            let stranger = Keypair::new().pubkey();
            assert!(prepare_with(&art, stranger, 41_380, 41_381, &o)
                .await
                .err()
                .unwrap()
                .contains("another wallet"));
            // the same: resumed
            let world = prepare_with(&art, w, 41_380, 41_381, &o)
                .await
                .expect("the resumed world");
            assert!(world.resumed);
            assert_eq!(world.metadata["persist"]["resumed"], true);
            let state = world.state.clone();
            let after =
                [a.season, a.citizen(&w), home.0].map(|k| account(&state, &k, "a").unwrap());
            assert_eq!(
                after, before,
                "the Season, the Citizen and the Holding, byte for byte"
            );
            let (_tx, mut stop) = tokio::sync::watch::channel(false);
            let (again, _) = await_home(&world, &w, &mut stop)
                .await
                .expect("the same home, found again");
            assert_eq!(
                (again.holding, again.home),
                home,
                "the home is found in the recovered history"
            );
            world.running.stop();
        });
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(
            next_cursor(cursor, &[]),
            cursor,
            "an empty page keeps the cursor"
        );
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
        assert_eq!(
            got,
            vec![(2, 0, 0), (2, 0, 1), (-2, 1, 0), (-2, 1, 1), (-2, 1, 2)]
        );
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
        assert_eq!(
            joined(&cd, &Address::new_from_array([8; 32])),
            None,
            "another wallet"
        );
        assert_eq!(joined(&cd[..10], &w), None, "short");
    }

    #[test]
    fn a_placehome_is_identified_exactly_at_one_candidate() {
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let w = Address::new_from_array([7; 32]);
        let player = ix::Player {
            actor: w,
            payer: w,
            wallet: w,
        };
        let want = ix::place_home(
            &a,
            &player,
            ix::Site {
                p: 2,
                q: 0,
                site: 1,
            },
            1,
            4,
        );
        // as a compiled message grants them: a key listed twice (actor = payer = wallet) gets the union of its privileges
        let merged = |k: &Address| {
            want.accounts
                .iter()
                .filter(|m| &m.pubkey == k)
                .fold((false, false), |(s, w), m| {
                    (s || m.is_signer, w || m.is_writable)
                })
        };
        let dec = DecodedIx {
            program: want.program_id,
            metas: want
                .accounts
                .iter()
                .map(|m| {
                    let (s, w) = merged(&m.pubkey);
                    (m.pubkey, s, w)
                })
                .collect(),
            data: want.data.clone(),
        };
        let cands = [(2, 0, 0), (2, 0, 1), (2, 0, 2)];
        assert_eq!(
            place_home_exact(&a, &w, 1, 4, &cands, &dec),
            Some((2, 0, 1))
        );
        assert_eq!(
            place_home_exact(&a, &w, 1, 4, &[(2, 0, 0)], &dec),
            None,
            "not a candidate"
        );
        assert_eq!(
            place_home_exact(&a, &w, 2, 4, &cands, &dec),
            None,
            "another faction"
        );
        assert_eq!(
            place_home_exact(&a, &w, 1, 3, &cands, &dec),
            None,
            "another shard"
        );
        assert_eq!(
            place_home_exact(&a, &Address::new_from_array([8; 32]), 1, 4, &cands, &dec),
            None,
            "another wallet"
        );
        let mut other = dec.clone();
        other.data.push(0);
        assert_eq!(
            place_home_exact(&a, &w, 1, 4, &cands, &other),
            None,
            "other data"
        );
    }
}
