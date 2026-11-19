//! The PLAYABLE lane's ordinary sealed march (program version 0x4804): the
//! legacy Depart (0x50) → Reveal (0x51) → GatherClash (0x60) →
//! ResolveFromInputs (0x61) → SettleTransit (0x54) / SettleDeparture (0x52)
//! that local play sends (`permutation-gateway/src/frontier/local-play-march.mjs`
//! sends the page's Depart; the world's keeper reveals and settles it,
//! `keeper/src/play.rs`). The verifier judges these with the S1 checks
//! (V4 windows, V5 seals, V6 quotas, V7 replay, …); before this file no
//! playable-lane recording had a host, a march or a resolved bell (the
//! natural recording's Muster is refused `NotResident`, 26).
//!
//! * `record_playable_march` (ignored; needs the devnet-playable `.so`,
//!   `PSF_PLAYABLE_SO`, sha256 ec511123…): a real season in LiteSVM, by its
//!   own instructions, whose genesis round is the shipped quicknet fixture
//!   round 32 551 749 and whose march arrives at bell 21, whose THE anchor
//!   round is T(21) = 32 556 349: the REAL round whose signature the S-TLOCK
//!   q4 vector ships (`prev_round_sig`). So the march's seal is a real
//!   quicknet time-lock, PostAnchor verifies the real signature on chain,
//!   and SettleTransit opens the seal with it (the verifier opens it again).
//! * **Declared patches** (set_account, logged as `PATCH`): THE anchor of
//!   every other resolved bell (no shipped round exists for them) and the
//!   SeedCache of every bell that needs a seed (the arrival bell's seed
//!   round S(21) cannot be a shipped round either: the reveal window, 600 s,
//!   plus the seed margin, 60 s, is longer than the 639 s from T(21) to the
//!   q4 round). The same class of patch as `playable_wide_next.rs`
//!   `stage_seed` and `playable_wide_march.rs` patch 2′. In a real season
//!   PostAnchor / PostSeed put them in the archive.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_DUMP=/abs/out.json.gz \
//!  cargo test -p verify --features playable-lane --test playable_march -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::ix::{self, AnchorSource, SeedSource};
use fclient::ports::Account;
use fclient::{tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use permutation_rules::frontier::beacon::{
    self as kb, genesis_seed_round, genesis_ts as beacon_genesis_ts, round_time, BeaconClock,
    WindowSchedule,
};
use permutation_rules::frontier::geometry::{home_nation, locate, ProvinceCoord};
use permutation_rules::hex::{Hex, DIRECTIONS};
use verify_core::input::{Config, Input};
use verify_core::Verdict;

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
const PLAYABLE_SHA256: &str = "ec511123493c23e9ab1f83295e4bf666bc48c8e3f8dcfee2298d9371cc483ca3";
/// A shipped fixture round (`fclient/fixtures/quicknet`).
const GENESIS_ROUND: u64 = 32_551_749;
/// The arrival bell: T(21) = GENESIS_ROUND + 200 · (21 + 2).
const ARRIVE_BELL: u32 = 21;
/// T(21): the q4 vector's previous round, a real quicknet round.
const ARRIVE_ROUND: u64 = 32_556_349;

fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
    p.base.program_version = PROGRAM_VERSION;
    p
}

fn budget() -> tx::TxBudget {
    tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: Some(256 * 1024),
    }
}

/// The real signature of `ARRIVE_ROUND` (the S-TLOCK q4 vector's
/// `prev_round_sig`; q4's round is `ARRIVE_ROUND + 1`).
fn arrive_sig() -> [u8; 48] {
    let p = fclient::seal::fixture_dir().join("q4-vector.json");
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&p).expect("q4 vector")).expect("json");
    assert_eq!(v["round"].as_u64(), Some(ARRIVE_ROUND + 1));
    hex::decode(v["prev_round_sig"].as_str().expect("prev_round_sig"))
        .expect("hex")
        .try_into()
        .expect("48 B")
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
    last_code: Option<u32>,
}

impl Rec {
    fn try_send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) -> bool {
        let (bh, _) = self.c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &bh).expect("build");
        let sig = match self.c.submit(&tx::wire(&t)) {
            Ok(s) => s,
            Err(e) => {
                self.log
                    .push(format!("{what}: refused before landing: {e}"));
                self.last_code = None;
                return false;
            }
        };
        self.c.produce_block();
        let l = self.c.transaction(&sig).cloned().expect("landed");
        let ok = l.err.is_none();
        self.last_code = l.code;
        self.log.push(format!(
            "{what}: {}",
            if ok {
                "ok".to_string()
            } else {
                format!("failed {:?} code {:?}", l.err, l.code)
            }
        ));
        ok
    }
    fn send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) {
        assert!(self.try_send(signers, ixs, what), "{:#?}", self.log);
    }
    fn advance_to(&mut self, to: i64) {
        while self.c.unix_timestamp() < to {
            let gap = to - self.c.unix_timestamp();
            self.c.set_scale((gap as f64 / 0.4).clamp(1.0, 2_000.0));
            self.c.produce_block();
        }
        self.c.set_scale(1.0);
    }
    fn data(&self, k: &Address) -> Option<Vec<u8>> {
        self.c.account(k).map(|a| a.data)
    }
    fn patch(&mut self, k: Address, data: Vec<u8>, what: &str) {
        let a = Account {
            lamports: 1_000_000_000,
            data,
            owner: self.a.program,
            executable: false,
        };
        self.c.set_account(k, a).expect("patch");
        self.log.push(format!("PATCH (set_account): {what}"));
    }
}

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

/// The Season's beacon clock, window schedule, seed margin and genesis.
fn clock_of(sd: &[u8]) -> (BeaconClock, WindowSchedule, u32, i64) {
    let le = |o: usize, n: usize| {
        let mut b = [0u8; 8];
        b[..n].copy_from_slice(&sd[o..o + n]);
        u64::from_le_bytes(b)
    };
    (
        BeaconClock {
            genesis: le(S::DRAND_GENESIS, 8) as i64,
            period: le(S::DRAND_PERIOD, 4) as i64,
        },
        WindowSchedule {
            reveal_window: le(S::REVEAL_WINDOW, 4) as u32,
            window_next: le(S::WINDOW_NEXT, 4) as u32,
            window_from_bell: le(S::WINDOW_FROM_BELL, 4) as u32,
        },
        le(S::SEED_MARGIN, 4) as u32,
        le(S::GENESIS_TS, 8) as i64,
    )
}

/// When THE anchor of `bell` lands: 5 s after T(bell) is due.
fn anchor_ts(sd: &[u8], bell: u32) -> i64 {
    let (clock, _, _, genesis_ts) = clock_of(sd);
    round_time(
        clock.genesis,
        clock.period as u32,
        kb::tlock_round(&clock, genesis_ts, bell),
    ) + 5
}

/// **Patch**: THE anchor of `(bell, region)`, landed at [`anchor_ts`],
/// with T(bell) as its round (no shipped signature).
fn patch_anchor(r: &mut Rec, bell: u32, region: u8) {
    let ctx = ctx_of(&r.a);
    let sd = r.data(&r.a.season).expect("season");
    let (clock, _, _, genesis_ts) = clock_of(&sd);
    let a_ts = anchor_ts(&sd, bell);
    let mut ad = vec![0u8; K2::BellAnchor.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut ad,
        K2::BellAnchor,
        SEASON_ID
    ));
    ad[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
    ad[BA::REGION] = region;
    ad[BA::ROUND..BA::ROUND + 8]
        .copy_from_slice(&kb::tlock_round(&clock, genesis_ts, bell).to_le_bytes());
    ad[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
    ad[BA::SLOT..BA::SLOT + 8].copy_from_slice(&1u64.to_le_bytes());
    r.patch(
        Address::new_from_array(ctx.bell_anchor(bell, region)),
        ad,
        &format!("BellAnchor(bell {bell}, region {region})"),
    );
}

/// **Patch**: the SeedCache of `(bell, region)` (nonce 0) with a literal
/// seed, over THE anchor present on chain.
fn patch_seed(r: &mut Rec, bell: u32, region: u8) {
    let ctx = ctx_of(&r.a);
    let sd = r.data(&r.a.season).expect("season");
    let (clock, sched, margin, _) = clock_of(&sd);
    let anchor_key = ctx.bell_anchor(bell, region);
    let ad = r
        .data(&Address::new_from_array(anchor_key))
        .expect("THE anchor");
    let a_ts = i64::from_le_bytes(ad[BA::A..BA::A + 8].try_into().unwrap());
    let round = kb::seed_round(
        &clock,
        kb::reveal_close(a_ts, kb::window(&sched, bell)),
        margin,
    );
    let mut cd = vec![0u8; K2::SeedCache.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut cd,
        K2::SeedCache,
        SEASON_ID
    ));
    cd[SC::BELL..SC::BELL + 4].copy_from_slice(&bell.to_le_bytes());
    cd[SC::REGION] = region;
    cd[SC::ROUND..SC::ROUND + 8].copy_from_slice(&round.to_le_bytes());
    let mut seed = [0u8; 32];
    seed[..4].copy_from_slice(&bell.to_le_bytes());
    seed[4] = region;
    seed[31] = 0x5e;
    cd[SC::SEED..SC::SEED + 32].copy_from_slice(&seed);
    cd[SC::ANCHOR_KEY..SC::ANCHOR_KEY + 32].copy_from_slice(&anchor_key);
    cd[SC::A..SC::A + 8].copy_from_slice(&a_ts.to_le_bytes());
    r.patch(
        Address::new_from_array(ctx.seed_cache(bell, region, 0)),
        cd,
        &format!("SeedCache(bell {bell}, region {region}, nonce 0), literal seed"),
    );
}

fn le32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

/// The province's `resolved_next`.
fn resolved_next(r: &Rec, p: i16, q: i16) -> u32 {
    let pd = r.data(&r.a.province(p.into(), q.into())).expect("province");
    le32(
        &pd,
        frontier_abi::v2::layout::province::province::RESOLVED_NEXT,
    )
}

/// The ordinary keeper steps for `(p, q)`'s bell `b` once its window is
/// closed: THE anchor (real at the arrival bell, else a declared patch),
/// then SkipQuiet; a bell that is not quiet is gathered (every position)
/// and resolved over a declared SeedCache.
fn resolve_bell(r: &mut Rec, keeper: &Keypair, p: i16, q: i16, b: u32) {
    let a = r.a.clone();
    let region = ix::region_of(p.into(), q.into());
    if r.data(&a.anchor(b, region)).is_none() {
        assert_ne!(
            b, ARRIVE_BELL,
            "the arrival bell's anchor is posted for real"
        );
        patch_anchor(r, b, region);
    }
    let sd = r.data(&a.season).expect("season");
    let (_, sched, _, _) = clock_of(&sd);
    let ad = r.data(&a.anchor(b, region)).expect("anchor");
    let a_ts = i64::from_le_bytes(ad[BA::A..BA::A + 8].try_into().unwrap());
    r.advance_to(kb::reveal_close(a_ts, kb::window(&sched, b)) + 1);
    if r.try_send(
        &[keeper],
        &[ix::skip_quiet(
            &a,
            keeper.pubkey(),
            (p.into(), q.into()),
            b,
            1,
            &[AnchorSource::Anchor],
        )],
        &format!("SkipQuiet ({p},{q}) bell {b}"),
    ) {
        return;
    }
    gather_and_resolve(r, keeper, p, q, b);
}

fn gather_and_resolve(r: &mut Rec, keeper: &Keypair, p: i16, q: i16, b: u32) {
    let a = r.a.clone();
    let region = ix::region_of(p.into(), q.into());
    let dest = (p as i32, q as i32);
    let positions: Vec<(u8, u8)> = (0..fclient::abi::FACTIONS)
        .flat_map(|f| (0..4u8).map(move |i| (f, i)))
        .collect();
    let mut holdings = vec![];
    let mut bitmap = 0u32;
    for (k, &(f, i)) in positions.iter().enumerate() {
        if let Some(sd) = r.data(&a.arrival_slot(dest.0, dest.1, b, f, i)) {
            let o = frontier_abi::layout::clash::arrival_slot::HOST_ID;
            let id = u64::from_le_bytes(sd[o..o + 8].try_into().unwrap());
            holdings.push(a.holding_of_host(id).expect("a host id"));
            bitmap |= 1 << k;
        }
    }
    r.send(
        &[keeper],
        &[ix::gather_clash(
            &a,
            keeper.pubkey(),
            dest,
            b,
            AnchorSource::Anchor,
            0,
            &positions,
            &holdings,
            bitmap,
            &keeper.pubkey(),
        )],
        &format!("GatherClash ({p},{q}) bell {b}"),
    );
    if r.data(&a.seed_cache(b, region, 0)).is_none() {
        patch_seed(r, b, region);
    }
    r.send(
        &[keeper],
        &[ix::resolve_from_inputs(
            &a,
            keeper.pubkey(),
            dest,
            b,
            SeedSource::Cache { nonce: 0 },
            &keeper.pubkey(),
        )],
        &format!("ResolveFromInputs ({p},{q}) bell {b}"),
    );
}

/// Resolve `(p, q)` through bell `last` (inclusive).
fn resolve_through(r: &mut Rec, keeper: &Keypair, p: i16, q: i16, last: u32) {
    loop {
        let b = resolved_next(r, p, q);
        if b > last {
            return;
        }
        resolve_bell(r, keeper, p, q, b);
        assert!(resolved_next(r, p, q) > b, "{:#?}", r.log);
    }
}

/// The bell at the chain's time.
fn now_bell(r: &Rec) -> u32 {
    let sd = r.data(&r.a.season).expect("season");
    let (_, _, _, genesis_ts) = clock_of(&sd);
    kb::bell_at(genesis_ts, r.c.unix_timestamp()).expect("after genesis")
}

fn bell_start(r: &Rec, b: u32) -> i64 {
    let sd = r.data(&r.a.season).expect("season");
    let (_, _, _, genesis_ts) = clock_of(&sd);
    kb::bell_start(genesis_ts, b)
}

/// One step from `(p, q, tile)` in direction `d`: the province and tile.
fn step(p: i16, q: i16, tile: u8, d: u8) -> (i32, i32, u8) {
    let h = ProvinceCoord::new(p.into(), q.into())
        .tile(tile)
        .expect("tile");
    let (dq, dr) = DIRECTIONS[d as usize];
    let (pc, t) = locate(Hex::new(h.q + dq, h.r + dr));
    (pc.p, pc.q, t)
}

#[test]
#[ignore = "needs the devnet-playable .so built from main: set PSF_PLAYABLE_SO (sha256 ec511123…), run with --ignored"]
fn record_playable_march() {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert_eq!(
        hex::encode(so_hash),
        PLAYABLE_SHA256,
        "not the devnet-playable build"
    );
    assert_eq!(localnet::bls_and_sbpf_v2_active(), (true, true));

    let rounds = FixtureDrand::load(&fb::fixture_dir(), fb::quicknet_info())
        .expect("fixture rounds verify")
        .rounds;
    let beacon = rounds.get(&GENESIS_ROUND).expect("a shipped round").clone();
    let p = params();
    let clock = BeaconClock {
        genesis: p.base.drand_genesis,
        period: p.base.drand_period as i64,
    };
    let margin = p.base.seed_margin;
    let t_create_min = round_time(clock.genesis, p.base.drand_period, GENESIS_ROUND)
        - kb::SEED_LEAD_SECS
        - margin as i64;
    assert_eq!(
        genesis_seed_round(&clock, t_create_min, margin),
        GENESIS_ROUND
    );
    let genesis_ts = beacon_genesis_ts(&clock, GENESIS_ROUND);
    assert_eq!(
        kb::tlock_round(&clock, genesis_ts, ARRIVE_BELL),
        ARRIVE_ROUND
    );
    let g0 = t_create_min - frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS - 3_600;

    let program = Address::new_from_array([0x45; 32]);
    let a = Addresses::new(program, SEASON_ID);
    let mut c = localnet::Chain::new(localnet::Config {
        g0,
        allow_tamper: false,
        data_dir: None,
        ..localnet::Config::default()
    });
    let upgrade = Keypair::new_from_array([0xA1; 32]);
    let keeper = Keypair::new_from_array([0xA2; 32]);
    let wallet = Keypair::new_from_array([0xB1; 32]);
    let session = Keypair::new_from_array([0xB2; 32]);
    c.deploy(
        program,
        &so,
        fclient::fees::deploy_max_len(so.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    c.airdrop(&upgrade.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&keeper.pubkey(), 100_000_000_000).unwrap();
    c.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    c.produce_block();
    let mut r = Rec {
        c,
        a,
        log: vec![],
        last_code: None,
    };
    let a = r.a.clone();

    // ---- 1. the natural opening (as playable_lane.rs)
    let sp = p.to_bytes();
    let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
    r.send(
        &[&upgrade],
        &[ix::announce_season(
            &a,
            upgrade.pubkey(),
            params_hash_v2(&sp, &payout),
            t_create_min,
            frontier_abi::presets::MIN_CREATION_BOND,
        )],
        "AnnounceSeason",
    );
    r.advance_to(t_create_min);
    r.send(
        &[&upgrade],
        &[ix::create_season(&a, upgrade.pubkey(), &sp, &payout)],
        "CreateSeason",
    );
    r.send(
        &[&upgrade],
        &[ix::init_beacon_logs(&a, upgrade.pubkey())],
        "InitBeaconLogs",
    );
    for f in 0..fclient::abi::FACTIONS {
        r.send(
            &[&upgrade],
            &[ix::init_shards(&a, upgrade.pubkey(), f)],
            "InitShards",
        );
    }
    r.advance_to(round_time(clock.genesis, p.base.drand_period, GENESIS_ROUND) + 1);
    let arg = ix::BeaconArg {
        round: GENESIS_ROUND,
        sig48: beacon.sig48,
        hints: fb::hints_bytes(GENESIS_ROUND),
    };
    r.send(
        &[&keeper],
        &[ix::consume_genesis_seed(&a, keeper.pubkey(), &arg)],
        "ConsumeGenesisSeed",
    );
    r.advance_to(genesis_ts + 2 * 600 + 1);
    let sd = r.data(&a.season).expect("season");
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let seed: [u8; 32] = sd[S::GENESIS_SEED..][..32].try_into().unwrap();
    let rings_opened = |r: &Rec| -> u16 {
        let fd = r.data(&a.frontier()).expect("frontier");
        u16::from_le_bytes(
            fd[frontier_abi::layout::world::frontier::RINGS_OPENED..][..2]
                .try_into()
                .unwrap(),
        )
    };
    while rings_opened(&r) <= cq.heartland_max_ring as u16 {
        let d = rings_opened(&r);
        r.send(
            &[&keeper],
            &[ix::open_ring(&a, keeper.pubkey(), d)],
            "OpenRing",
        );
    }
    let mut home_of = None;
    'find: for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 != ring {
                    continue;
                }
                if let Some(n) = home_nation(coord, cq.placement, cq.heartland_max_ring, &seed) {
                    home_of = Some((pp as i16, qq as i16, n));
                    break 'find;
                }
            }
        }
    }
    let (hp, hq, faction) = home_of.expect("a home province");
    r.send(
        &[&keeper],
        &[ix::open_province(&a, keeper.pubkey(), hp, hq)],
        "OpenProvince (home)",
    );

    // ---- 2. the player: Join, PlaceHome, Train
    let now = r.c.unix_timestamp();
    r.send(
        &[&wallet],
        &[ix::join(
            &a,
            wallet.pubkey(),
            wallet.pubkey(),
            faction,
            &session.pubkey(),
            now + 12 * 3_600,
            None,
        )],
        "Join",
    );
    let cd = r.data(&a.citizen(&wallet.pubkey())).expect("citizen");
    let shard = cd[144];
    let player = ix::Player {
        actor: wallet.pubkey(),
        payer: wallet.pubkey(),
        wallet: wallet.pubkey(),
    };
    let mut home = None;
    for site in 0..frontier_abi::v2::layout::province::province::SITES_N as u8 {
        let s = ix::Site { p: hp, q: hq, site };
        if r.try_send(
            &[&wallet],
            &[ix::place_home(&a, &player, s, faction, shard)],
            &format!("PlaceHome site {site}"),
        ) {
            home = Some(site);
            break;
        }
    }
    let site = home.expect("a PlaceHome lands");
    let h = ix::HoldingRef { p: hp, q: hq, site };
    let with_province = |mut i: Instruction| {
        let k = a.province(hp.into(), hq.into());
        if !i.accounts.iter().any(|m| m.pubkey == k) {
            i.accounts.push(AccountMeta::new_readonly(k, false));
        }
        i
    };
    // ABI v2 (§5.6, a conquest Season): Depart, SettleDeparture and
    // SettleTransit end with `[holding_province r]`.
    let with_hp = |mut i: Instruction| {
        i.accounts.push(AccountMeta::new_readonly(
            a.province(hp.into(), hq.into()),
            false,
        ));
        i
    };
    r.send(
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h))],
        "Harvest",
    );
    for n in [200u32, 150, 100] {
        if r.try_send(
            &[&wallet],
            &[with_province(ix::train(&a, &player, h, 0, n))],
            &format!("Train {n} Spearmen"),
        ) {
            break;
        }
    }
    let hd = r
        .data(&a.holding(hp.into(), hq.into(), site))
        .expect("holding");
    let tile = hd[frontier_abi::v2::layout::player::holding::TILE];
    let reserve0 = |r: &Rec| -> u32 {
        let hd = r.data(&a.holding(hp.into(), hq.into(), site)).unwrap();
        let o = frontier_abi::v2::layout::player::holding::RESERVE;
        u32::from_le_bytes(hd[o..o + 4].try_into().unwrap())
    };

    // ---- 3. the home province resolved bell by bell; Muster once trained
    let mut mustered = false;
    let last_muster_bell = ARRIVE_BELL - 4;
    while !mustered {
        let b = now_bell(&r);
        assert!(b <= last_muster_bell, "no muster in time: {:#?}", r.log);
        if b >= 2 {
            resolve_through(&mut r, &keeper, hp, hq, b - 2);
        }
        r.try_send(
            &[&wallet],
            &[with_province(ix::harvest(&a, &player, h))],
            &format!("Harvest bell {b}"),
        );
        let n = reserve0(&r);
        r.log.push(format!("reserve[0] = {n} at bell {b}"));
        if n >= 100 {
            mustered = r.try_send(
                &[&wallet],
                &[ix::muster(&a, &player, h, 0, n, tile)],
                &format!("Muster {n} bell {b}"),
            );
        }
        if !mustered {
            let next = bell_start(&r, now_bell(&r) + 1) + 2;
            r.advance_to(next);
        }
    }
    // The muster settles at the next resolve.
    let mut host = None;
    while host.is_none() {
        let b = now_bell(&r);
        resolve_through(&mut r, &keeper, hp, hq, b - 2);
        let pd = r.data(&a.province(hp.into(), hq.into())).unwrap();
        for i in 0..frontier_abi::layout::province::province::ENTRIES_N {
            if let Ok(e) = frontier_abi::entry::read_entry(&pd, i) {
                if e.state == 1 && e.faction == faction {
                    host = Some(e);
                }
            }
        }
        if host.is_none() {
            let next = bell_start(&r, b + 1) + 2;
            r.advance_to(next);
        }
    }
    let host = host.unwrap();
    r.log.push(format!(
        "host {:#x} on tile {} ready at bell {}",
        host.id, host.tile, host.ready_bell
    ));

    // ---- 4. Depart, sealed to T(ARRIVE_BELL) under the real quicknet key
    let pk96 = fb::quicknet_info().public_key;
    let mut departed = None;
    // A tile of the home province first (the only opened one).
    let mut dirs: Vec<u8> = (0..6).collect();
    dirs.sort_by_key(|&d| {
        let (dp, dq, _) = step(hp, hq, host.tile, d);
        (dp, dq) != (hp.into(), hq.into())
    });
    for d in dirs {
        let (dp, dq, dt) = step(hp, hq, host.tile, d);
        let (path_len, path) = permutation_rules::frontier::seal::encode_path(&[d]).expect("path");
        let plain = fclient::seal::Plain {
            version: 1,
            host_id: host.id,
            arrive_bell: ARRIVE_BELL,
            dest_p: dp as i16,
            dest_q: dq as i16,
            dest_tile: dt,
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: Default::default(),
        };
        let packed = fclient::seal::pack(&plain);
        let sealed =
            fclient::seal::seal_with_key(&packed, &pk96, ARRIVE_ROUND, &[0x3c; 16]).expect("seal");
        let args = ix::DepartArgs {
            host_id: host.id,
            commit: sealed.commit,
            seal: sealed.seal,
            arrive_bell: ARRIVE_BELL,
            tip: 1_000_000,
            transit_slot: 0,
        };
        if r.try_send(
            &[&wallet],
            &[with_hp(ix::depart(&a, &player, h, (hp, hq), &args))],
            &format!("Depart dir {d} → ({dp},{dq}) tile {dt}"),
        ) {
            departed = Some((plain, packed, sealed, (dp, dq)));
            break;
        }
    }
    let (plain, packed, sealed, dest) =
        departed.unwrap_or_else(|| panic!("a Depart lands: {:#?}", r.log));
    let depart_bell = now_bell(&r);
    let _ = plain;

    // ---- 5. the bells up to the arrival; the real anchor; Reveal
    let region = ix::region_of(dest.0, dest.1);
    let mut origin_settled = false;
    while now_bell(&r) < ARRIVE_BELL + 1 {
        let b = now_bell(&r);
        resolve_through(
            &mut r,
            &keeper,
            hp,
            hq,
            b.saturating_sub(2).min(ARRIVE_BELL - 1),
        );
        if !origin_settled && resolved_next(&r, hp, hq) > depart_bell {
            // The origin's half (the Spend resolved at the depart bell).
            r.send(
                &[&keeper],
                &[with_hp(ix::settle_departure(
                    &a,
                    keeper.pubkey(),
                    (hp, hq),
                    h,
                    0,
                ))],
                "SettleDeparture",
            );
            origin_settled = true;
        }
        r.advance_to(bell_start(&r, b + 1) + 2);
    }
    let sd = r.data(&a.season).expect("season");
    r.advance_to(anchor_ts(&sd, ARRIVE_BELL));
    let arrive = ix::BeaconArg {
        round: ARRIVE_ROUND,
        sig48: arrive_sig(),
        hints: fb::hints_bytes(ARRIVE_ROUND),
    };
    r.send(
        &[&keeper],
        &[ix::post_anchor(
            &a,
            keeper.pubkey(),
            region,
            ARRIVE_BELL,
            &arrive,
            &keeper.pubkey(),
        )],
        "PostAnchor (bell 21, the REAL round 32556349)",
    );
    let reveal = ix::RevealArgs {
        holding: h,
        transit_slot: 0,
        target_i: 0,
        plain: packed,
        salt: sealed.salt,
        ct_hash: sealed.ct_hash,
        beneficiary: keeper.pubkey(),
        dest,
        arrive: ARRIVE_BELL,
        faction,
        day_writable: true,
        path_provinces: vec![],
    };
    r.send(
        &[&keeper],
        &[ix::reveal(&a, keeper.pubkey(), &reveal)],
        "Reveal",
    );

    // ---- 6. the arrival bell: gathered and resolved; the settlements
    resolve_through(&mut r, &keeper, dest.0 as i16, dest.1 as i16, ARRIVE_BELL);
    let st = ix::SettleTransitArgs {
        holding: h,
        transit_slot: 0,
        commit: sealed.commit,
        seal: sealed.seal,
        beneficiary: keeper.pubkey(),
        dest,
        arrive: ARRIVE_BELL,
        faction,
        slot_i: 0,
        home: (hp.into(), hq.into()),
        anchor_present: true,
        slot_beneficiary: keeper.pubkey(),
        resolver: keeper.pubkey(),
        holding_rent_payer: wallet.pubkey(),
        camp_citizen: None,
    };
    // SettleTransit waits `SETTLE_AFTER_CLOSE_SECS` (600 s) past the close.
    let ad = r.data(&a.anchor(ARRIVE_BELL, region)).expect("anchor");
    let a_ts = i64::from_le_bytes(ad[BA::A..BA::A + 8].try_into().unwrap());
    r.advance_to(a_ts + 600 + 600 + 1);
    r.send(
        &[&keeper],
        &[with_hp(ix::settle_transit(&a, keeper.pubkey(), &st))],
        "SettleTransit",
    );
    r.log.push(format!("departed at bell {depart_bell}"));

    // ---- the archive (unfiltered: wallet post-states too)
    let txs: Vec<fclient::ports::TxRecord> =
        r.c.feed(0, usize::MAX, Some(&program))
            .into_iter()
            .map(|l| l.record())
            .collect();
    let finals: BTreeMap<[u8; 32], Option<Account>> = verify_core::input::written_keys(&txs)
        .into_iter()
        .map(|k| (k.to_bytes(), r.c.account(&k)))
        .collect();
    let input = Input {
        cfg: Config {
            program,
            season_id: SEASON_ID,
            quicknet_pk: pk96,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so_hash),
        },
        txs,
        finals,
        final_slot: r.c.slot(),
        program_hashes: vec![(0, so_hash)],
        provenance: format!(
            "verify/tests/playable_march.rs record_playable_march: the devnet-playable .so (sha256 {PLAYABLE_SHA256}) in localnet::Chain (LiteSVM, in process), program version 0x4804, genesis on the shipped quicknet round {GENESIS_ROUND}, the march's THE anchor on the real round {ARRIVE_ROUND} (S-TLOCK q4 prev_round_sig); declared patches: THE anchors of the other resolved bells and the SeedCaches; steps: {}",
            r.log.join("; ")
        ),
        scenarios: vec!["playable-march".into()],
        history: Default::default(),
        resident_feed: None,
    };
    for l in &r.log {
        println!("{l}");
    }
    let rep = verify_core::verify(&input);
    for f in &rep.findings {
        println!(
            "{:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    println!("verdict {:?}", rep.verdict);
    if let Ok(out) = std::env::var("PLAYABLE_DUMP") {
        input.save(std::path::Path::new(&out)).expect("save");
        println!("saved {out}");
    }
}

// ------------------------------------------------------------ the recording

/// The committed recording (`PLAYABLE_DUMP` of [`record_playable_march`]).
fn recorded() -> Input {
    common::fixture("playable-march-whole.json.gz")
}

/// The successful transactions whose program instruction has tag `tag`.
fn txs_with(inp: &Input, tag: u8) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none()
                && fclient::tx::from_wire(&inp.txs[t].tx).is_ok_and(|tx| {
                    let keys = &tx.message.account_keys;
                    tx.message.instructions.iter().any(|c| {
                        keys[c.program_id_index as usize] == inp.cfg.program
                            && c.data.first() == Some(&tag)
                    })
                })
        })
        .collect()
}

/// The findings that are not PASS-compatible, as (severity, check, code, entity).
fn bad(rep: &verify_core::Report) -> Vec<(String, String, String, String)> {
    rep.findings
        .iter()
        .filter(|f| f.severity != verify_core::Severity::Warn)
        .map(|f| {
            (
                format!("{:?}", f.severity),
                f.check.to_string(),
                f.code.clone(),
                format!("{} | {}", f.entity, f.detail),
            )
        })
        .collect()
}

/// Whether a finding is one the declared patches explain: THE anchor of a
/// skipped bell other than the arrival bell (V4 `MissingData`), or the
/// arrival bell's seed (V7 `MissingData`, "no seed of the bell").
fn declared(f: &verify_core::Finding) -> bool {
    f.severity == verify_core::Severity::Unverifiable
        && f.code == "MissingData"
        && ((f.check == "V4" && f.entity.starts_with("SKIP ") && f.bell != ARRIVE_BELL)
            || (f.check == "V7" && f.bell == ARRIVE_BELL && f.detail.contains("no seed")))
}

#[test]
fn the_recording_has_the_whole_sealed_march() {
    let inp = recorded();
    for (tag, what) in [
        (0x10u8, "PostAnchor"),
        (0x43, "Muster"),
        (0x50, "Depart"),
        (0x51, "Reveal"),
        (0x52, "SettleDeparture"),
        (0x54, "SettleTransit"),
        (0x60, "GatherClash"),
        (0x61, "ResolveFromInputs"),
        (0x63, "SkipQuiet"),
    ] {
        assert!(!txs_with(&inp, tag).is_empty(), "{what} ({tag:#04x})");
    }
    // The one PostAnchor is the arrival bell's, on the REAL round.
    let t = txs_with(&inp, 0x10);
    assert_eq!(t.len(), 1);
    let tx = fclient::tx::from_wire(&inp.txs[t[0]].tx).unwrap();
    let ci = tx
        .message
        .instructions
        .iter()
        .find(|c| tx.message.account_keys[c.program_id_index as usize] == inp.cfg.program)
        .unwrap();
    let round = u64::from_le_bytes(ci.data[6..14].try_into().unwrap());
    assert_eq!(round, ARRIVE_ROUND);
    assert_eq!(ci.data[14..62], arrive_sig());
    assert!(inp.provenance.contains("PATCH"), "the patches are declared");
}

/// The honest whole archive: no FAIL, and every UNVERIFIABLE finding is
/// a declared patch's (no shipped beacon round exists for them). Nothing
/// is a PASS it should not be: the archive is UNVERIFIABLE as a whole.
#[test]
fn the_honest_march_has_no_fail_and_only_the_declared_patches_are_unverifiable() {
    let rep = verify_core::verify(&recorded());
    assert_eq!(rep.verdict, Verdict::Unverifiable, "{:#?}", bad(&rep));
    let others: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.severity != verify_core::Severity::Warn && !declared(f))
        .collect();
    assert!(others.is_empty(), "{:#?}", bad(&rep));
    // Every skipped bell but the arrival's, and the arrival bell's seed.
    assert!(rep.findings.iter().any(|f| f.check == "V7" && declared(f)));
    assert!(
        rep.findings
            .iter()
            .filter(|f| f.check == "V4" && declared(f))
            .count()
            >= 15
    );
    for c in ["V3", "V4", "V5", "V6", "V7", "V13"] {
        assert!(
            rep.checks_run.iter().any(|x| x.starts_with(c)),
            "{c}: {:?}",
            rep.checks_run
        );
    }
}

/// The repo's march tamper classes over the playable recording. Each one
/// that this archive can carry must FAIL with its code; the list of those
/// that apply is pinned, so it cannot shrink silently.
#[test]
fn the_march_tamper_classes_fail_on_the_playable_march() {
    use verify_core::tamper as tc;
    let inp = recorded();
    let classes: [(&str, fn(&Input) -> tc::Made); 14] = [
        ("T1", tc::t01),
        ("T2", tc::t02),
        ("T6", tc::t06),
        ("T6b", tc::t06b),
        ("T7", tc::t07),
        ("T9", tc::t09),
        ("T12", tc::t12),
        ("T13", tc::t13),
        ("T13moved", tc::t13_moved),
        ("T14", tc::t14_any),
        ("T15", tc::t15),
        ("T17", tc::t17),
        ("T22", tc::t22),
        ("T23", tc::t23),
    ];
    let mut applied = vec![];
    for (name, f) in classes {
        let case = match f(&inp) {
            Ok(c) => c,
            Err(e) => {
                println!("{name}: not applicable here ({e})");
                continue;
            }
        };
        let r = verify_core::verify(&case.input);
        if NOT_PASS_ONLY.contains(&name) {
            // The forged bell is the arrival bell, whose seed no shipped
            // round can give (a declared patch): V7 stops at MissingData
            // before its replay. Never a PASS; a FAIL once PostSeed is in
            // the archive (devnet).
            assert_eq!(r.verdict, Verdict::Unverifiable, "{name}: {:#?}", bad(&r));
            println!("{name}: UNVERIFIABLE ({}), never a PASS", case.what);
            continue;
        }
        assert_eq!(
            r.verdict,
            Verdict::Fail,
            "{name} ({}) must FAIL: {:#?}",
            case.what,
            bad(&r)
        );
        // The class's own code, or (on this archive) the checks it reaches
        // first: the verdict is what matters for the prize gate.
        let own = case.codes.iter().any(|c| r.fails_with(c));
        let mut by: Vec<String> = r
            .findings
            .iter()
            .filter(|f| f.severity == verify_core::Severity::Fail)
            .map(|f| format!("{}:{}", f.check, f.code))
            .collect();
        by.sort();
        by.dedup();
        println!("{name}: FAIL ({}), own code {own}, by {by:?}", case.what);
        applied.push((name, own));
    }
    println!("applied: {applied:?}");
    assert!(applied.len() >= 3, "{applied:?}");
    assert_eq!(
        applied, APPLIED_CLASSES,
        "the pinned classes this recording carries, and whether each FAILs with its own code"
    );
}

/// The classes `the_march_tamper_classes_fail_on_the_playable_march`
/// applies to this recording (pinned).
const APPLIED_CLASSES: &[(&str, bool)] = &[
    ("T1", false),
    ("T2", true),
    ("T6", false),
    ("T7", true),
    ("T9", true),
    ("T12", false),
    ("T14", false),
    ("T17", true),
];

/// Classes whose forgery sits on the arrival bell's resolve: UNVERIFIABLE
/// offline (no PostSeed), never a PASS.
const NOT_PASS_ONLY: &[&str] = &["T23"];

// ------------------------------------------------------------ own tampers

fn program_ix_data(tx: &fclient::Transaction, program: &Address) -> usize {
    tx.message
        .instructions
        .iter()
        .position(|c| tx.message.account_keys[c.program_id_index as usize] == *program)
        .expect("a program instruction")
}

/// Rewrites the data of transaction `t`'s program instruction.
fn edit_data(inp: &mut Input, t: usize, f: impl FnOnce(&mut Vec<u8>)) {
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let i = program_ix_data(&tx, &inp.cfg.program);
    f(&mut tx.message.instructions[i].data);
    inp.txs[t].tx = fclient::tx::wire(&tx);
}

/// The arrival bell's PostAnchor signed by another round (a real signature,
/// of q4's round): the verifier re-verifies the BLS signature over THE
/// anchor's round and refuses it.
#[test]
fn an_anchor_with_another_rounds_signature_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, 0x10)[0];
    let p = fclient::seal::fixture_dir().join("q4-vector.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    let sig = hex::decode(v["sig"].as_str().unwrap()).unwrap();
    edit_data(&mut inp, t, |d| d[14..62].copy_from_slice(&sig));
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(rep.fails_with("BeaconSigInvalid"), "{:#?}", bad(&rep));
}

/// The arrival bell's anchor posted on a round that is not T(21): the next
/// round, with ITS real signature (the BLS check alone would pass), the
/// ANCHOR record saying that round too and the chains re-computed (a
/// consistent forger). The program refuses it (`WrongRound`).
#[test]
fn an_anchor_on_the_wrong_round_fails() {
    use verify_core::tamper as tc;
    let mut inp = recorded();
    let t = txs_with(&inp, 0x10)[0];
    let p = fclient::seal::fixture_dir().join("q4-vector.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    let sig = hex::decode(v["sig"].as_str().unwrap()).unwrap();
    edit_data(&mut inp, t, |d| {
        d[6..14].copy_from_slice(&(ARRIVE_ROUND + 1).to_le_bytes());
        d[14..62].copy_from_slice(&sig);
    });
    let (at, i) = tc::find(&inp, frontier_abi::log::Kind::ANCHOR)[0];
    assert_eq!(at, t);
    let (o, n) = tc::field(frontier_abi::log::Kind::ANCHOR, "round");
    tc::edit_payload(&mut inp, at, i, |pl| {
        pl[o..o + n].copy_from_slice(&(ARRIVE_ROUND + 1).to_le_bytes()[..n])
    });
    tc::rechain(&mut inp);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
}

/// A Reveal whose plaintext names another destination tile (a forged
/// reveal: the commitment no longer opens).
#[test]
fn a_forged_reveal_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, 0x51)[0];
    // tag, transit slot, target i, then the 37-B plaintext: dest_tile at 17.
    edit_data(&mut inp, t, |d| d[3 + 17] ^= 1);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(rep.fails_with("RevealCommitMismatch"), "{:#?}", bad(&rep));
}

/// The arrival bell gathered before its reveal window closed (an early
/// arrival latch: the program's `window_closed` refuses it, `TooEarly`).
#[test]
fn a_gather_before_the_window_closed_fails() {
    let mut inp = recorded();
    let reveal = txs_with(&inp, 0x51)[0];
    let t = txs_with(&inp, 0x60)[0];
    inp.txs[t].block_time = inp.txs[reveal].block_time + 1;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(rep.fails_with("LatchBeforeClose"), "{:#?}", bad(&rep));
}

/// The march revealed after its window closed.
#[test]
fn a_reveal_after_the_close_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, 0x51)[0];
    let g = txs_with(&inp, 0x60)[0];
    inp.txs[t].block_time = inp.txs[g].block_time;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(rep.fails_with("RevealAfterClose"), "{:#?}", bad(&rep));
}

/// The settlement's seal swapped for one that does not open under T(21)'s
/// signature: the verifier opens the seal itself.
#[test]
fn a_settlement_with_a_forged_seal_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, 0x54)[0];
    // tag, transit slot, commit 32, then the 165-B seal: flip a byte of V.
    edit_data(&mut inp, t, |d| d[2 + 32 + 100] ^= 1);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
}

/// Lamports drained from the Holding (the escrowed fee and bond) at the
/// settlement, with the final state matching (a consistent drain).
#[test]
fn a_drained_holding_at_the_settlement_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, 0x54)[0];
    let tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let ci = &tx.message.instructions[program_ix_data(&tx, &inp.cfg.program)];
    let holding = tx.message.account_keys[ci.accounts[2] as usize];
    for u in t..inp.txs.len() {
        for (k, a) in inp.txs[u].post.iter_mut() {
            if *k == holding {
                if let Some(a) = a {
                    a.lamports -= 10_000;
                }
            }
        }
    }
    if let Some(Some(a)) = inp.finals.get_mut(&holding.to_bytes()) {
        a.lamports -= 10_000;
    }
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
}
