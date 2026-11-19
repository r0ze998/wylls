//! VX on the playable lane's **expedition wrapper** and **Free City
//! conquest** (Q16-1 = A, prize gate, 2026-11-19): the recording behind
//! `checks::vx_reexec`, which re-executes every transaction with an
//! expedition dispatch envelope instruction (kinds 0–18) by the pinned
//! program from the archive's states.
//!
//! One recording of the devnet-playable `.so` built from `origin/main`
//! `c889f6cf` (sha256 da3dc1aa…, unchanged since #79; committed gzipped as
//! `fixtures/verify/devnet-playable-da3dc1aa.so.gz` for VX), in the
//! in-process LiteSVM chain (`localnet::Chain`), made by
//! `record_playable_expedition` (ignored; needs the artefact), the
//! UNFILTERED feed:
//!
//! 1. the season, the wide land and the rim homes as
//!    `playable_wide_march.rs` makes them (its declared patches: RingSeed(128)
//!    and the Frontier's wedge counters; three players' final Town homes at
//!    the rim (128, 0), whose Province is a REAL OpenProvince here, preset
//!    `S1_DEVNET_WIDE_7D`);
//! 2. **declared patch 3**: player 0's original host (3,000 troops, the
//!    explicitly strong fixture of `itest::conquest_real`) on its rim home's
//!    tile and the rim's `resolved_next`;
//! 3. all real: **ExpeditionDepart** (kind 0) sealed to T(arrive) with the
//!    real quicknet key and routed onto the tile of a wide province's Free
//!    City, the origin bell gathered and resolved, **SettleOrigin** (1), the
//!    destination resolved bell by bell (WideResolve), **ExpeditionReveal**
//!    (2), **ExpeditionGather** (3), the arrival's WideResolve, **SettleMember**
//!    (6); then the player's **DeclareSiege** (12) of the Free City and the
//!    keeper's **ResolveWithConquest** (13) bell by bell, then
//!    **SettleCapture** (14) or **SettleSiege** (15);
//! 4. THE anchor and SeedCache of every resolved bell **declared** with a
//!    literal seed (no live drand: O-M1-12).
//!
//! Every patch is in the archive's `declared` list (`Input::declared`), so
//! VX re-executes from the very states the recorder set and reports a
//! transaction that starts from one as UNVERIFIABLE, never PASS.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_EXPEDITION_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_expedition -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::original_expedition_depart_draft::Draft as DepartDraft;
use fclient::ports::Account;
use fclient::wide_conquest_draft::Draft as ConquestDraft;
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::archive_part_of;
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::layout::player::{accrual as AC, citizen as C, holding as H, holding_ref as HR};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS, season as S};
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::province::site as SM2;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2};
use frontier_abi::world_index::arrival::{WideArrival, WideClashInputsHdr};
use frontier_abi::world_index::conquest::{
    capture_escrow_address, conquest_address, WideCaptureEscrow, WideConquest,
};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_dispatch_ix as dx;
use frontier_abi::world_index::expedition_settlement_ix::DraftCommand as MemberCommand;
use frontier_abi::world_index::expedition_transport::{ExpeditionArrivalSlot, OwnedBridgeTransit};
use frontier_abi::world_index::march::transit_address;
use frontier_abi::world_index::seal::WidePlain;
use frontier_abi::world_index::tiles::WideTile;
use frontier_abi::world_index::TileAddress;
use frontier_abi::world_index::{
    arrival as wa, holding as wh,
    land::{self as wl, WideProvince},
    roster as wro,
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    wide_ix as wix, ProvinceKey, WideCoord, WorldId,
};
use permutation_rules::frontier::beacon::{
    self as kb, genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time,
    BeaconClock, WindowSchedule,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord, PLACEMENT_MIXED};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use verify_core::input::{Config, Declared, Input};

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
/// The devnet-playable `.so` of `origin/main` c889f6cf (unchanged since #79, 78b602d9).
const MAIN_SHA256: &str = "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";
const RULES: wr::RuleBytes = wr::RuleBytes {
    keep_holder: KeepHolderRule::MixedInterleaved as u8,
    // (⑧ (d), #69: a placement-2 Season — `S1_LOCAL_7D` since #69 — takes
    //  the deployed formula; `CanonicalHashV1` is refused `BadData`)
    free_city: FreeCityRule::DeployedLe32V1 as u8,
    camp: CampRule::SortKeyDrawV1 as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
const OPENINGS: [(i64, i64); 3] = [(129, 0), (129, -1), (128, 1)];
/// The legacy rim province the players' first homes are patched into.
const RIM: (i32, i32) = (128, 0);
/// Stores of a patched rim home, milli-units per resource.
const STORES: i64 = 5_000_000_000;

fn params() -> SeasonParamsV2 {
    // `S1_DEVNET_WIDE_7D` (#60): S1_LOCAL_7D with `r_max_ceiling` 128, so a
    // legacy OpenProvince of the rim (128, 0) lands for real.
    let mut p = frontier_abi::v2::presets::S1_DEVNET_WIDE_7D;
    p.base.program_version = PROGRAM_VERSION;
    // ⑧ wide land (i): the disk's keeps mixed on every ring, so the wide
    // rules must name MixedInterleaved (`rules::keep_holder_allowed`).
    p.cq.placement = PLACEMENT_MIXED;
    p
}

fn budget() -> tx::TxBudget {
    tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        // (the wrapper's Depart and DeclareSiege do not complete in the
        // default 32 KiB heap: fclient `DEPART_HEAP_FRAME`)
        heap: Some(256 * 1024),
    }
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
    /// The declared patches (`Input::declared`), in force from before the
    /// archive's transaction `at`.
    declared: Vec<Declared>,
    /// The logs of the last landed transaction (diagnostics).
    last_logs: Vec<String>,
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
                return false;
            }
        };
        self.c.produce_block();
        let l = self.c.transaction(&sig).cloned().expect("landed");
        let ok = l.err.is_none();
        self.last_logs = l.logs.clone();
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
        if !self.try_send(signers, ixs, what) {
            let tail: Vec<_> = self.last_logs.iter().rev().take(12).rev().collect();
            panic!("{what} failed: {tail:#?}\n{:#?}", self.log);
        }
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
    fn feed_len(&self) -> usize {
        self.c.feed(0, usize::MAX, Some(&self.a.program)).len()
    }
    /// A declared `set_account` patch (`Input::declared`).
    fn put(&mut self, k: [u8; 32], a: Account, what: &str) {
        self.c.set_account(adr(k), a.clone()).expect("patch");
        let at = self.feed_len();
        self.declared.push(Declared {
            at,
            key: k,
            account: Some(a),
            what: what.to_string(),
        });
        self.log
            .push(format!("PATCH (set_account, declared): {what}"));
    }
    fn patch(&mut self, k: [u8; 32], data: Vec<u8>, what: &str) {
        let a = Account {
            lamports: 1_000_000_000,
            data,
            owner: self.a.program,
            executable: false,
        };
        self.put(k, a, what);
    }
    fn edit(&mut self, k: [u8; 32], what: &str, f: impl FnOnce(&mut Vec<u8>)) {
        let mut a = self.c.account(&adr(k)).expect("an account to patch");
        f(&mut a.data);
        self.put(k, a, what);
    }
    fn archive(
        &self,
        from: usize,
        program: &Address,
    ) -> (
        Vec<fclient::ports::TxRecord>,
        BTreeMap<[u8; 32], Option<Account>>,
    ) {
        let txs: Vec<fclient::ports::TxRecord> = self
            .c
            .feed(0, usize::MAX, Some(program))
            .into_iter()
            .map(|l| l.record())
            .skip(from)
            .collect();
        // The UNFILTERED feed, as the real pipeline archives it
        // (D-verify-pr72-10): every writable account's post-state, the
        // wallets included, and the final of every written key
        // (`input::written_keys`).
        let finals = verify_core::input::written_keys(&txs)
            .into_iter()
            .map(|k| (k.to_bytes(), self.c.account(&k)))
            .collect();
        (txs, finals)
    }
}

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

fn wide_ix(a: &Addresses, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts,
        data,
    }
}

fn set_rules_ix(a: &Addresses, authority: &Address, keep_holder: u8) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wr::rules_config_address(&c)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::SetRules {
            config_version: wr::WIDE_RULES_CONFIG_VERSION,
            keep_holder,
            free_city: RULES.free_city,
            camp: RULES.camp,
            region: RULES.region,
        }
        .to_bytes()
        .to_vec(),
    )
}

fn request_ix(a: &Addresses, payer: &Address, ring: u64) -> Instruction {
    let c = ctx_of(a);
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.frontier(), false),
        AccountMeta::new_readonly(adr(c.ring_seed(128)), false),
        AccountMeta::new(adr(wl::ring_seed_address(&c, ring)), false),
    ];
    for w in 0..6u8 {
        accounts.push(AccountMeta::new_readonly(adr(c.province_fund(w)), false));
    }
    accounts.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    wide_ix(
        a,
        accounts,
        wix::RequestRingSeed { ring }.to_bytes().to_vec(),
    )
}

fn consume_ix(
    a: &Addresses,
    payer: &Address,
    ring: u64,
    round: u64,
    sig48: [u8; 48],
) -> Instruction {
    let c = ctx_of(a);
    let hints: [u8; frontier_abi::ix::HINTS_LEN] =
        fb::hints_bytes(round).try_into().expect("hints");
    wide_ix(
        a,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&c, ring)), false),
        ],
        wix::ConsumeRingSeed {
            ring,
            round,
            sig48,
            hints,
        }
        .to_bytes()
        .to_vec(),
    )
}

fn open_ix(a: &Addresses, payer: &Address, p: i64, q: i64) -> Instruction {
    let c = ctx_of(a);
    let coord = WideCoord::checked(p, q).expect("a wide coordinate");
    let wedge = coord.wedge().expect("a wedge");
    wide_ix(
        a,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&c, coord.ring())), false),
            AccountMeta::new(adr(c.province_fund(wedge)), false),
            AccountMeta::new(adr(wl::province_address(&c, coord)), false),
            AccountMeta::new_readonly(adr(wr::rules_config_address(&c)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::OpenProvince { p, q }.to_bytes().to_vec(),
    )
}

/// A player of the recording.
struct Member {
    wallet: Keypair,
    faction: u8,
    shard: u8,
    citizen: [u8; 32],
    rim_site: u8,
}

/// The Season's beacon clock, window schedule and seed margin.
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

/// **Patch**: THE anchor and the SeedCache of `(bell, region)` with the
/// literal `seed`, anchored 100 s into the bell (as `stage_seed`).
/// Returns `final_ts` of a ticket of that bell.
fn stage_seed(r: &mut Rec, bell: u32, region: u8, seed: [u8; 32]) -> i64 {
    let ctx = ctx_of(&r.a);
    let sd = r.data(&r.a.season).expect("season");
    let (clock, sched, margin, genesis_ts) = clock_of(&sd);
    let a_ts = genesis_ts + 600 * bell as i64 + 100;
    let round = kb::seed_round(
        &clock,
        kb::reveal_close(a_ts, kb::window(&sched, bell)),
        margin,
    );
    let anchor_key = ctx.bell_anchor(bell, region);
    let mut ad = vec![0u8; K2::BellAnchor.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut ad,
        K2::BellAnchor,
        SEASON_ID
    ));
    ad[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
    ad[BA::REGION] = region;
    ad[BA::ROUND..BA::ROUND + 8].copy_from_slice(&round.to_le_bytes());
    ad[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
    ad[BA::SLOT..BA::SLOT + 8].copy_from_slice(&1u64.to_le_bytes());
    let mut cd = vec![0u8; K2::SeedCache.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut cd,
        K2::SeedCache,
        SEASON_ID
    ));
    cd[SC::BELL..SC::BELL + 4].copy_from_slice(&bell.to_le_bytes());
    cd[SC::REGION] = region;
    cd[SC::ROUND..SC::ROUND + 8].copy_from_slice(&round.to_le_bytes());
    cd[SC::SEED..SC::SEED + 32].copy_from_slice(&seed);
    cd[SC::ANCHOR_KEY..SC::ANCHOR_KEY + 32].copy_from_slice(&anchor_key);
    cd[SC::A..SC::A + 8].copy_from_slice(&a_ts.to_le_bytes());
    r.patch(
        anchor_key,
        ad,
        &format!("BellAnchor(bell {bell}, region {region})"),
    );
    r.patch(
        ctx.seed_cache(bell, region, 0),
        cd,
        &format!("SeedCache(bell {bell}, region {region}, nonce 0), literal seed"),
    );
    round_time(clock.genesis, clock.period as u32, round) + 600
}

fn input_of(
    program: Address,
    so_hash: [u8; 32],
    txs: Vec<fclient::ports::TxRecord>,
    finals: BTreeMap<[u8; 32], Option<Account>>,
    final_slot: u64,
    provenance: String,
    scenario: &str,
) -> Input {
    Input {
        cfg: Config {
            program,
            season_id: SEASON_ID,
            quicknet_pk: fb::quicknet_info().public_key,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so_hash),
        },
        txs,
        finals,
        final_slot,
        program_hashes: vec![(0, so_hash)],
        provenance,
        scenarios: vec![scenario.into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared: vec![],
    }
}

/// A System program transfer (instruction 2, `lamports u64`).
fn transfer_ix(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: fclient::addr::system_program(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

/// 0xDC op 1 WideResolve of `bell` of the province at `coord` (residents
/// only: no ClashInputs, no ArrivalDay).
fn resolve_ix(
    a: &Addresses,
    payer: &Address,
    coord: WideCoord,
    bell: u32,
    region: u8,
) -> Instruction {
    let c = ctx_of(a);
    let pkey = ProvinceKey::new(world_of(a), coord);
    wide_ix(
        a,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::province_address(&c, coord)), false),
            AccountMeta::new(adr(wro::roster_address(&c, pkey)), false),
            AccountMeta::new_readonly(adr(c.seed_cache(bell, region, 0)), false),
            AccountMeta::new_readonly(adr(c.bell_anchor(bell, region)), false),
            AccountMeta::new(adr(wa::clash_inputs_address(&c, pkey, bell)), false),
            AccountMeta::new_readonly(
                adr(wa::arrival_day_address(&c, pkey, wa::day_of(bell))),
                false,
            ),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::Resolve {
            bell,
            beneficiary: payer.to_bytes(),
        }
        .to_bytes()
        .to_vec(),
    )
}

fn world_of(a: &Addresses) -> WorldId {
    WorldId::derive_legacy_season(&a.season.to_bytes(), &a.program.to_bytes()).expect("world")
}

fn resolved_next(r: &Rec, coord: WideCoord) -> u32 {
    let d = r
        .data(&adr(wl::province_address(&ctx_of(&r.a), coord)))
        .expect("the wide province");
    u32::from_le_bytes(d[PV::RESOLVED_NEXT..][..4].try_into().unwrap())
}

/// The time THE anchor's reveal window of `bell` closes (`stage_seed`'s
/// anchor time).
fn window_close(r: &Rec, bell: u32) -> i64 {
    let sd = r.data(&r.a.season).expect("season");
    let (_clock, sched, _margin, genesis_ts) = clock_of(&sd);
    kb::reveal_close(
        genesis_ts + 600 * bell as i64 + 100,
        kb::window(&sched, bell),
    )
}

/// Resolve every bell of `coord` from its `resolved_next` up to (not
/// including) `to`, each over a staged anchor + SeedCache (declared patch
/// 2').
fn resolve_through(r: &mut Rec, payer: &Keypair, coord: WideCoord, region: u8, to: u32) {
    loop {
        let b = resolved_next(r, coord);
        if b >= to {
            break;
        }
        // A bell whose anchor an earlier instruction already read (a ticket
        // bell) keeps its staged seed: one patch per bell.
        if r.c
            .account(&adr(ctx_of(&r.a).bell_anchor(b, region)))
            .is_none()
        {
            stage_seed(r, b, region, seed_of(b));
        }
        let close = window_close(r, b);
        if r.c.unix_timestamp() < close + 1 {
            r.advance_to(close + 1);
        }
        r.send(
            &[payer],
            &[resolve_ix(&r.a.clone(), &payer.pubkey(), coord, b, region)],
            &format!("WideResolve bell {b}"),
        );
    }
}

/// The literal seed of a staged bell.
fn seed_of(bell: u32) -> [u8; 32] {
    let mut s = [0x6Bu8; 32];
    s[..4].copy_from_slice(&bell.to_le_bytes());
    s
}

#[test]
#[ignore = "needs the devnet-playable .so built from main: set PSF_PLAYABLE_SO (sha256 da3dc1aa…), run with --ignored"]
fn record_playable_expedition() {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert_eq!(
        hex::encode(so_hash),
        MAIN_SHA256,
        "not the devnet-playable build of main (da3dc1aa)"
    );
    assert_eq!(localnet::bls_and_sbpf_v2_active(), (true, true));

    let rounds = FixtureDrand::load(&fb::fixture_dir(), fb::quicknet_info())
        .expect("fixture rounds verify")
        .rounds;
    let round = GENESIS_ROUND;
    let beacon = rounds.get(&round).expect("the shipped genesis round");
    let p = params();
    let clock = BeaconClock {
        genesis: p.base.drand_genesis,
        period: p.base.drand_period as i64,
    };
    let margin = p.base.seed_margin;
    let t_create_min = round_time(clock.genesis, p.base.drand_period, round)
        - permutation_rules::frontier::beacon::SEED_LEAD_SECS
        - margin as i64;
    assert_eq!(genesis_seed_round(&clock, t_create_min, margin), round);
    let genesis_ts = beacon_genesis_ts(&clock, round);
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
    let payer = Keypair::new_from_array([0xA2; 32]);
    c.deploy(
        program,
        &so,
        fclient::fees::deploy_max_len(so.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    c.airdrop(&upgrade.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&payer.pubkey(), 500_000_000_000).unwrap();
    c.produce_block();
    let mut r = Rec {
        c,
        a,
        log: vec![],
        declared: vec![],
        last_logs: vec![],
    };
    let a = r.a.clone();
    let ctx = ctx_of(&a);

    // ---- 1. The natural season.
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
    r.advance_to(round_time(clock.genesis, p.base.drand_period, round) + 1);
    let arg = ix::BeaconArg {
        round,
        sig48: beacon.sig48,
        hints: fb::hints_bytes(round),
    };
    r.send(
        &[&payer],
        &[ix::consume_genesis_seed(&a, payer.pubkey(), &arg)],
        "ConsumeGenesisSeed",
    );
    r.advance_to(genesis_ts + 2 * 600 + 1);
    let sd = r.data(&a.season).expect("season");
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let rings_opened = |r: &Rec| -> u16 {
        let fd = r.data(&a.frontier()).expect("frontier");
        u16::from_le_bytes(fd[FR::RINGS_OPENED..][..2].try_into().unwrap())
    };
    while rings_opened(&r) <= cq.heartland_max_ring as u16 {
        let d = rings_opened(&r);
        r.send(
            &[&payer],
            &[ix::open_ring(&a, payer.pubkey(), d)],
            "OpenRing",
        );
    }
    // One home province for each of three nations.
    let mut homes: Vec<(i16, i16, u8)> = vec![];
    for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 != ring {
                    continue;
                }
                if let Some(n) = home_nation(coord, cq.placement, cq.heartland_max_ring, &gseed) {
                    if homes.len() < 3 && !homes.iter().any(|h| h.2 == n) {
                        r.send(
                            &[&payer],
                            &[ix::open_province(&a, payer.pubkey(), pp as i16, qq as i16)],
                            "OpenProvince",
                        );
                        homes.push((pp as i16, qq as i16, n));
                    }
                }
            }
        }
    }
    assert_eq!(homes.len(), 3, "three nations' home provinces");
    let mut members: Vec<Member> = vec![];
    for (i, &(hp, hq, faction)) in homes.iter().enumerate() {
        let wallet = Keypair::new_from_array([0xB1 + i as u8; 32]);
        r.c.airdrop(&wallet.pubkey(), 100_000_000_000).unwrap();
        r.c.produce_block();
        let session = Keypair::new_from_array([0xC1 + i as u8; 32]);
        let now = r.c.unix_timestamp();
        r.send(
            &[&wallet],
            &[ix::join(
                &a,
                wallet.pubkey(),
                wallet.pubkey(),
                faction,
                &session.pubkey(),
                now + 6 * 3_600,
                None,
            )],
            "Join",
        );
        let citizen = a.citizen(&wallet.pubkey());
        let cd = r.data(&citizen).expect("citizen");
        let shard = cd[C::JOIN_SHARD];
        let player = ix::Player {
            actor: wallet.pubkey(),
            payer: wallet.pubkey(),
            wallet: wallet.pubkey(),
        };
        let mut placed = false;
        for site in 0..PV::SITES_N as u8 {
            let s = ix::Site { p: hp, q: hq, site };
            if r.try_send(
                &[&wallet],
                &[ix::place_home(&a, &player, s, faction, shard)],
                &format!("PlaceHome site {site}"),
            ) {
                placed = true;
                break;
            }
        }
        assert!(placed, "a PlaceHome lands");
        members.push(Member {
            wallet,
            faction,
            shard,
            citizen: citizen.to_bytes(),
            rim_site: i as u8,
        });
    }

    // ---- 1b. The rules: OrbitBalanced is refused under placement 2
    // (`BadData`, #38), MixedInterleaved is taken.
    assert_eq!(cq.placement, PLACEMENT_MIXED);
    let refused = !r.try_send(
        &[&upgrade],
        &[set_rules_ix(
            &a,
            &upgrade.pubkey(),
            KeepHolderRule::OrbitBalanced as u8,
        )],
        "WideSetRules(OrbitBalanced) under placement 2 (refused)",
    );
    assert!(refused, "main's program refuses the forbidden keep holder");
    r.send(
        &[&upgrade],
        &[set_rules_ix(&a, &upgrade.pubkey(), RULES.keep_holder)],
        "WideSetRules(MixedInterleaved)",
    );
    // ---- 2. The wide land (patch 1, then real).
    let model_ring = adr(ctx.ring_seed(cq.heartland_max_ring as u16));
    let mut rs = r.c.account(&model_ring).expect("a real seeded RingSeed");
    assert_eq!(rs.data[RS::STATUS], RS::STATUS_SEEDED);
    rs.data[RS::D..RS::D + 2].copy_from_slice(&128u16.to_le_bytes());
    rs.data[RS::OPENED_BELL..RS::OPENED_BELL + 4].copy_from_slice(&0u32.to_le_bytes());
    r.put(
        ctx.ring_seed(128),
        rs,
        "RingSeed(128) seeded, opened_bell 0",
    );
    r.edit(
        a.frontier().to_bytes(),
        "Frontier wedge_occupied = wedge_open",
        |d| {
            for w in 0..6 {
                let o = FR::WEDGE_OPEN + 4 * w;
                let mut open = u32::from_le_bytes(d[o..o + 4].try_into().unwrap());
                if open == 0 {
                    open = 1;
                    d[o..o + 4].copy_from_slice(&open.to_le_bytes());
                }
                let oc = FR::WEDGE_OCCUPIED + 4 * w;
                d[oc..oc + 4].copy_from_slice(&open.to_le_bytes());
            }
        },
    );
    let need = wl::ring_rent(129, frontier_abi::layout::rent(wl::province::SIZE) * 2).unwrap()
        + 10 * frontier_abi::layout::rent(wl::province::SIZE) * 2;
    for w in 0..6u8 {
        let f = adr(ctx.province_fund(w));
        let have = r.c.account(&f).map(|x| x.lamports).unwrap_or(0);
        if have < need {
            r.send(
                &[&payer],
                &[transfer_ix(&payer.pubkey(), &f, need - have)],
                &format!("fund top-up wedge {w} (system transfer)"),
            );
        }
    }
    let bound = rounds
        .keys()
        .copied()
        .find(|&rr| {
            let t = round_time(clock.genesis, p.base.drand_period, rr)
                - permutation_rules::frontier::beacon::SEED_LEAD_SECS
                - margin as i64;
            t > r.c.unix_timestamp() + 5 && t >= genesis_ts + 600
        })
        .expect("a shipped round after now");
    let t_req = round_time(clock.genesis, p.base.drand_period, bound)
        - permutation_rules::frontier::beacon::SEED_LEAD_SECS
        - margin as i64
        - 1;
    r.advance_to(t_req - 1);
    assert_eq!(ring_seed_round(&clock, r.c.unix_timestamp(), margin), bound);
    r.send(
        &[&payer],
        &[request_ix(&a, &payer.pubkey(), 129)],
        "WideRequestRingSeed(129)",
    );
    r.advance_to(round_time(clock.genesis, p.base.drand_period, bound) + 1);
    let sig = rounds.get(&bound).expect("bound round").sig48;
    r.send(
        &[&payer],
        &[consume_ix(&a, &payer.pubkey(), 129, bound, sig)],
        "WideConsumeRingSeed(129)",
    );
    let mut opened = vec![];
    for (pp, qq) in OPENINGS {
        if r.try_send(
            &[&payer],
            &[open_ix(&a, &payer.pubkey(), pp, qq)],
            &format!("WideOpenProvince({pp},{qq})"),
        ) {
            opened.push(WideCoord::checked(pp, qq).unwrap());
        }
    }
    assert!(opened.len() >= 2, "{:#?}", r.log);

    // ---- 3. Patch 2: the players' final Town homes at the rim.
    let rim_prov = ctx.province(RIM.0, RIM.1);
    // The rim province itself is REAL: a legacy OpenProvince of (128, 0)
    // over the declared RingSeed(128) (`r_max_ceiling` 128).
    r.send(
        &[&payer],
        &[ix::open_province(
            &a,
            payer.pubkey(),
            RIM.0 as i16,
            RIM.1 as i16,
        )],
        "OpenProvince(128,0) (the rim)",
    );
    let mut pd = r.data(&adr(rim_prov)).expect("the real rim Province");
    let free: Vec<u8> = (0..pd[PV::SITE_COUNT])
        .filter(|&s| pd[PV::site(s as usize) + SM::STATE] == SM::STATE_FREE)
        .collect();
    assert!(free.len() >= members.len(), "free rim sites {free:?}");
    for (i, m) in members.iter_mut().enumerate() {
        m.rim_site = free[i];
    }
    for (i, m) in members.iter().enumerate() {
        let (hp, hq, _) = homes[i];
        let cd = r.data(&adr(m.citizen)).unwrap();
        let o = C2::holding_of_slot(1);
        let home_site = cd[o + HR::SITE];
        let mut hd = r
            .data(&a.holding(hp.into(), hq.into(), home_site))
            .expect("the PlaceHome holding");
        assert_eq!(hd[H::ORDER], 1);
        hd[H::P..H::P + 2].copy_from_slice(&(RIM.0 as i16).to_le_bytes());
        hd[H::Q..H::Q + 2].copy_from_slice(&(RIM.1 as i16).to_le_bytes());
        hd[H::SITE] = m.rim_site;
        hd[H::TILE] = pd[PV::SITES + m.rim_site as usize];
        hd[H::STATE] = H::STATE_FINAL;
        hd[H::TIER] = Tier::Town as u8;
        for res in 0..RESOURCES {
            let so = H::store(res) + AC::VALUE;
            hd[so..so + 8].copy_from_slice(&STORES.to_le_bytes());
        }
        let gen = hd[H::GEN];
        r.patch(
            ctx.holding(RIM.0, RIM.1, m.rim_site),
            hd,
            &format!(
                "player {i}'s final Town home at the rim (128,0) site {}",
                m.rim_site
            ),
        );
        let so = PV::site(m.rim_site as usize);
        pd[so + SM::STATE] = SM::STATE_HOLDING;
        pd[so + SM::FACTION] = m.faction;
        pd[so + SM::ORDER] = 1;
        pd[so + SM::TIER] = Tier::Town as u8;
        pd[so + SM::GEN] = gen;
        pd[PV::N_SITES_USED] += 1;
        let site = m.rim_site;
        r.edit(
            m.citizen,
            &format!("player {i}'s Citizen slot 1 → the rim home, first home final"),
            |cd| {
                cd[o + HR::P..o + HR::P + 2].copy_from_slice(&(RIM.0 as i16).to_le_bytes());
                cd[o + HR::Q..o + HR::Q + 2].copy_from_slice(&(RIM.1 as i16).to_le_bytes());
                cd[o + HR::SITE] = site;
                cd[o + HR::GEN] = gen;
                cd[C::FLAGS] |= C::FLAG_FIRST_HOLDING_FINAL;
            },
        );
    }
    r.edit(
        rim_prov,
        "the real rim Province's site mirrors of the three homes",
        |d| *d = pd.clone(),
    );

    // ---- 4. The witnessed segment: a hostile claim, every bell resolved,
    // ---- 4. Declared patch 3: player 0's original host at its rim home
    // (a roster entry of STRONG troops, the holding's host_seq), the rim's
    // `resolved_next` at the current bell (no legacy keeper ran there), and
    // one declaration's cost in the home's stores (they are full already).
    let m0 = &members[0];
    let site0 = m0.rim_site;
    let h0 = ctx.holding(RIM.0, RIM.1, site0);
    let rim_coord = WideCoord::checked(RIM.0 as i64, RIM.1 as i64).unwrap();
    let world = world_of(&a);
    let rim_key = ProvinceKey::new(world, rim_coord);
    let bell_now = |r: &Rec| -> u32 {
        frontier_abi::prologue::bell_at(genesis_ts, r.c.unix_timestamp()).unwrap()
    };
    let resolver = AccountResolver::for_season(&ctx).expect("a resolver");
    let hd0 = r.data(&adr(h0)).expect("the rim home");
    let gen0 = hd0[H::GEN];
    let rim_pd = r.data(&adr(rim_prov)).expect("the rim province");
    let tile0 = rim_pd[PV::SITES + site0 as usize];
    let id0 = frontier_abi::addr::host_id(RIM.0, RIM.1, site0, gen0, 0).expect("a host id");
    let host0 = resolver.legacy_host_ref(id0).expect("the host ref");
    let b_patch = bell_now(&r);
    r.edit(
        rim_prov,
        &format!("the rim province: player 0's host ({STRONG_TROOPS} milli-troops, unit {UNIT}) on its home tile, resolved_next = bell {b_patch}"),
        |pd| {
            use frontier_abi::entry::{write_entry, Entry, EntryOp};
            use frontier_abi::layout::province::entry as E2;
            use frontier_abi::v2::layout::province::province as P2;
            let n = pd[P2::N_ENTRIES] as usize;
            let entry = Entry {
                id: id0,
                unit: UNIT,
                faction: m0.faction,
                tile: tile0,
                state: E2::STATE_ROSTER,
                troops: STRONG_TROOPS,
                stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
                op: EntryOp::None,
                ..Entry::FREE
            };
            write_entry(pd, n, &entry).expect("the entry");
            pd[P2::N_ENTRIES] = (n + 1) as u8;
            pd[P2::RESOLVED_NEXT..P2::RESOLVED_NEXT + 4].copy_from_slice(&b_patch.to_le_bytes());
        },
    );
    r.edit(h0, "player 0's rim home: host_seq 1", |hd| {
        hd[H::HOST_SEQ..H::HOST_SEQ + 4].copy_from_slice(&1u32.to_le_bytes());
    });

    // ---- 5. The destination: the opened wide province with a Free City.
    let free_city = opened.iter().find_map(|&coord| {
        let d = r.data(&adr(wl::province_address(&ctx, coord)))?;
        (0..d[PV::SITE_COUNT] as usize)
            .find(|&s| d[PV::site(s) + SM::STATE] == SM2::STATE_FREE_CITY)
            .map(|s| (coord, s as u8, d[PV::SITES + s]))
    });
    let (dest_coord, fc_site, fc_tile) =
        free_city.expect("an opened wide province with a Free City");
    let dest = ProvinceKey::new(world, dest_coord);
    let dest_key = adr(wl::province_address(&ctx, dest_coord));
    let region = WideProvince::read(&r.data(&dest_key).unwrap())
        .unwrap()
        .region;
    r.log.push(format!(
        "destination {dest_coord:?} (region {region}): Free City at site {fc_site}, tile {fc_tile}"
    ));
    let mut lands = vec![masks_of(rim_key, &r.data(&adr(rim_prov)).unwrap())];
    for &coord in &opened {
        let k = ProvinceKey::new(world, coord);
        lands.push(masks_of(
            k,
            &r.data(&adr(wl::province_address(&ctx, coord))).unwrap(),
        ));
    }
    let origin = TileAddress::new(rim_key, tile0).unwrap();
    let route = derive_route_to(origin, dest, &lands, Some(fc_tile))
        .expect("a passable route ending on the Free City's tile");
    let upper = travel_upper(&route.steps, &lands);

    // ---- 6. ExpeditionDepart (kind 0), the player's, sealed to T(arrive).
    let sd = r.data(&a.season).unwrap();
    let season = fclient::decode::Season::decode(&sd).expect("the Season");
    let sclock = fclient::clock::SeasonClock::from_season(&season);
    let b0 = bell_now(&r);
    // The arrival bell is THE bell whose anchor round has a shipped real
    // signature (T(21) = q4's previous round): its PostAnchor is REAL, so
    // the member settlement opens the seal with the real beacon.
    let arrive = ARRIVE_BELL;
    assert!(
        permutation_rules::frontier::travel::earliest_arrival_bell(
            genesis_ts,
            r.c.unix_timestamp(),
            upper
        ) <= arrive
            && arrive <= b0 + 72,
        "the departure bell {b0} reaches bell {arrive}"
    );
    let tip = fclient::fees::min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let (path_len, path_bits) =
        permutation_rules::frontier::seal::encode_path(&route.dirs).expect("a path");
    let plain = WidePlain {
        version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION,
        host: host0,
        arrive_bell: arrive,
        dest,
        dest_tile: route.dest_tile,
        stance: 0,
        retreat_bps: 0,
        path_len,
        path: path_bits,
        reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES],
    };
    let sealed = fclient::wide_seal::seal_wide(
        &plain,
        &host0,
        arrive,
        &fb::quicknet_info().public_key,
        sclock.tlock_round(arrive),
    )
    .expect("a real wide seal");
    let w0 = m0.wallet.pubkey();
    let draft = DepartDraft::for_wallet(
        &ctx,
        host0,
        rim_key,
        w0,
        w0,
        0,
        arrive,
        tip,
        sealed.commit,
        sealed.seal,
    )
    .expect("a Depart draft");
    let depart = Instruction {
        program_id: program,
        accounts: draft
            .roles()
            .iter()
            .map(|ro| meta(ro.address, ro.signer, ro.writable))
            .collect(),
        data: dx::encode(dx::Kind::Depart, &draft.proposed_bytes()).expect("the wrapper"),
    };
    let wallet0 = Keypair::new_from_array([0xB1; 32]);
    assert_eq!(wallet0.pubkey(), w0);
    r.send(
        &[&wallet0],
        &[depart],
        &format!(
            "ExpeditionDepart bell {b0} → {dest_coord:?} tile {} arriving bell {arrive}",
            route.dest_tile
        ),
    );
    let external = adr(transit_address(&ctx, &h0, 0));

    // ---- 7. The origin bell b0 resolved (GatherClash, a declared SeedCache,
    // ResolveFromInputs), then SettleOrigin (kind 1).
    let keeper = Keypair::new_from_array([0xA3; 32]);
    r.c.airdrop(&keeper.pubkey(), 100_000_000_000).unwrap();
    r.c.produce_block();
    legacy_resolve(&mut r, &keeper, RIM.0 as i16, RIM.1 as i16, b0);
    r.send(
        &[&keeper],
        &[Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(rim_prov), false),
                AccountMeta::new(adr(h0), false),
                AccountMeta::new(adr(rim_prov), false),
                AccountMeta::new(external, false),
            ],
            data: dx::encode(
                dx::Kind::SettleOrigin,
                &wix::ExpeditionSettleOrigin { transit_slot: 0 }.to_bytes(),
            )
            .unwrap(),
        }],
        &format!("SettleOrigin bell {b0}"),
    );

    // ---- 8. The destination resolved up to the arrival bell; THE anchor
    // and SeedCache of the arrival bell declared before anything names
    // them; ExpeditionReveal (kind 2) inside the reveal window.
    resolve_through(&mut r, &keeper, dest_coord, region, arrive);
    let faction0 = {
        let t = OwnedBridgeTransit::from_bytes(&ctx, &r.data(&external).unwrap())
            .unwrap()
            .transit();
        t.faction
    };
    let rev = reveal_ix(
        &ctx,
        &w0,
        &adr(h0),
        0,
        faction0,
        arrive,
        region,
        dest,
        &sealed,
        0,
        &route,
    );
    r.send(
        &[&wallet0],
        &[rev],
        &format!("ExpeditionReveal bell {arrive} (before THE anchor)"),
    );
    let sd = r.data(&a.season).unwrap();
    r.advance_to(anchor_ts(&sd, arrive));
    let barg = ix::BeaconArg {
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
            arrive,
            &barg,
            &keeper.pubkey(),
        )],
        &format!("PostAnchor (bell {arrive}, region {region}, the REAL round {ARRIVE_ROUND})"),
    );
    patch_seed(&mut r, arrive, region);

    // ---- 9. Gather (kind 3) once the window closed, WideResolve of the
    // arrival bell over the gathered ClashInputs, SettleMember (kind 6).
    let close = anchor_close(&r, arrive, region);
    r.advance_to(close + 1);
    let gather = gather_ix(&r, &keeper.pubkey(), dest, dest_key, region, arrive);
    r.send(
        &[&keeper],
        &[gather],
        &format!("ExpeditionGather bell {arrive}"),
    );
    r.send(
        &[&keeper],
        &[resolve_ix(&a, &keeper.pubkey(), dest_coord, arrive, region)],
        &format!("WideResolve bell {arrive} (the arrival)"),
    );
    let inputs_k = adr(wa::clash_inputs_address(&ctx, dest, arrive));
    let ih = WideClashInputsHdr::read(&r.data(&inputs_k).unwrap()).unwrap();
    let position = faction0 as usize * 4;
    let fate = WideArrival::read_at(&r.data(&inputs_k).unwrap(), position)
        .unwrap()
        .map(|x| x.fate);
    r.log.push(format!("the arrival's fate: {fate:?}"));
    let slot_k = adr(wa::arrival_slot_address(&ctx, dest, arrive, faction0, 0));
    let t = OwnedBridgeTransit::from_bytes(&ctx, &r.data(&external).unwrap())
        .unwrap()
        .transit();
    let sl = ExpeditionArrivalSlot::read(&ctx, &r.data(&slot_k).unwrap()).unwrap();
    let rent_payer: [u8; 32] = r.data(&adr(h0)).unwrap()[H::RENT_PAYER..H::RENT_PAYER + 32]
        .try_into()
        .unwrap();
    // SettleMember is due `transit::SETTLE_AFTER_CLOSE_SECS` (600 s) after the close
    r.advance_to(close + 601);
    let settle = Instruction {
        program_id: program,
        data: dx::encode(
            dx::Kind::SettleMember,
            &MemberCommand::new(0, sealed.commit, sealed.seal)
                .unwrap()
                .to_bytes(),
        )
        .unwrap(),
        accounts: vec![
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(h0), false),
            AccountMeta::new(external, false),
            AccountMeta::new(adr(rim_prov), false),
            AccountMeta::new(dest_key, false),
            AccountMeta::new(inputs_k, false),
            AccountMeta::new(slot_k, false),
            AccountMeta::new(adr(t.rent_to), false),
            AccountMeta::new_readonly(a.anchor(arrive, region), false),
            AccountMeta::new(keeper.pubkey(), true),
            AccountMeta::new(adr(sl.common().beneficiary), false),
            AccountMeta::new(adr(ih.resolver), false),
            AccountMeta::new(adr(rent_payer), false),
            AccountMeta::new(keeper.pubkey(), false),
        ],
    };
    r.send(&[&keeper], &[settle], "SettleMember");

    // ---- 10. The Free City: the player's DeclareSiege (kind 12) from the
    // host now standing in the destination, then the keeper's
    // ResolveWithConquest (kind 13) bell by bell until the siege is
    // settled, SettleCapture (14) / SettleSiege (15).
    let pd = r.data(&dest_key).unwrap();
    let entry = (0..pd[PV::N_ENTRIES] as usize)
        .find(|&i| {
            frontier_abi::entry::read_entry(&pd, i)
                .is_ok_and(|e| e.id == id0 || e.faction == m0.faction)
        })
        .map(|i| i as u8);
    r.log
        .push(format!("the host's entry at the destination: {entry:?}"));
    let declared_ok = if let Some(entry) = entry {
        let d = ConquestDraft::declare_siege(&ctx, host0, dest, fc_site, entry, w0)
            .expect("a DeclareSiege draft");
        let ix = Instruction {
            program_id: program,
            accounts: d
                .roles()
                .iter()
                .map(|ro| meta(ro.address, ro.signer, ro.writable))
                .collect(),
            data: dx::encode(dx::Kind::DeclareSiege, &d.inner_bytes()).unwrap(),
        };
        r.try_send(
            &[&wallet0],
            &[ix],
            &format!("DeclareSiege of the Free City (site {fc_site}) from entry {entry}"),
        )
    } else {
        false
    };
    if !declared_ok {
        let tail: Vec<_> = r.last_logs.iter().rev().take(10).rev().cloned().collect();
        r.log.push(format!("DeclareSiege tail: {tail:?}"));
    }
    let conquest_k = adr(conquest_address(&ctx, dest));
    let mut taken = None;
    if declared_ok {
        for _ in 0..80 {
            let b = resolved_next_of(&r, dest_coord);
            if r.c.account(&adr(ctx.bell_anchor(b, region))).is_none() {
                stage_seed(&mut r, b, region, seed_of(b));
            }
            let close = window_close(&r, b);
            if r.c.unix_timestamp() < close + 1 {
                r.advance_to(close + 1);
            }
            r.send(
                &[&keeper],
                &[rwc_ix(&a, &keeper.pubkey(), dest, dest_key, region, b)],
                &format!("ResolveWithConquest bell {b}"),
            );
            let table = WideConquest::read(&r.data(&conquest_k).unwrap(), SEASON_ID, dest).unwrap();
            if let Some(e) = table.entry(fc_site).unwrap() {
                use frontier_abi::v2::layout::province::conquest as CR;
                r.log.push(format!(
                    "the site record after bell {b}: kind {} progress {}/{}",
                    e.rules.kind, e.rules.progress, e.rules.required
                ));
                if e.rules.kind == CR::KIND_CAPTURE_DUE || e.rules.kind == CR::KIND_NONE {
                    taken = Some((b, e));
                    break;
                }
            }
        }
    }
    r.log.push(format!(
        "the siege's end: {:?}",
        taken.as_ref().map(|(b, e)| (b, e.rules.kind))
    ));
    if let Some((_, e)) = &taken {
        let citizen = adr(m0.citizen);
        let escrow_k = adr(capture_escrow_address(&ctx, &m0.citizen));
        let src = adr(h0);
        let capture = Instruction {
            program_id: program,
            data: dx::encode(
                dx::Kind::SettleCapture,
                &wix::SettleCapture { site: fc_site }.to_bytes(),
            )
            .unwrap(),
            accounts: vec![
                AccountMeta::new(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(dest_key, false),
                AccountMeta::new(conquest_k, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new(a.join_shard(m0.faction, m0.shard), false),
                AccountMeta::new(escrow_k, false),
                AccountMeta::new(adr(wh::holding_address(&ctx, dest_coord, fc_site)), false),
                AccountMeta::new(src, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
        };
        if !r.try_send(&[&keeper], &[capture], "SettleCapture") {
            let escrow = r
                .data(&escrow_k)
                .and_then(|d| WideCaptureEscrow::read(&d, SEASON_ID, world, m0.citizen).ok());
            let mut m = vec![
                AccountMeta::new_readonly(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(dest_key, false),
                AccountMeta::new(conquest_k, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new(escrow_k, false),
                AccountMeta::new(adr(escrow.map(|x| x.funder()).unwrap_or([0; 32])), false),
            ];
            if e.source.is_some() {
                m.push(AccountMeta::new(src, false));
            }
            let siege = Instruction {
                program_id: program,
                data: dx::encode(
                    dx::Kind::SettleSiege,
                    &wix::SettleSiege { site: fc_site }.to_bytes(),
                )
                .unwrap(),
                accounts: m,
            };
            r.try_send(&[&keeper], &[siege], "SettleSiege");
        }
    }

    // ---- 11. The archive: the whole season from AnnounceSeason on, the
    // UNFILTERED feed, the declared patches with it.
    let (txs, finals) = r.archive(0, &program);
    let mut whole = input_of(
        program,
        so_hash,
        txs,
        finals,
        r.c.slot(),
        format!(
            "verify/tests/playable_expedition.rs record_playable_expedition: the devnet-playable .so built from origin/main c889f6cf (sha256 {MAIN_SHA256}) in localnet::Chain (LiteSVM, in process); a real placement-2 season by its own instructions, the declared wide land patch (RingSeed(128), Frontier wedge counters) and the real ring-129 opening, the declared rim-homes patch (as playable_wide_march.rs), the declared host patch (player 0's {STRONG_TROOPS} milli-troop host on its rim home, the rim's resolved_next), THE anchor and SeedCache of every resolved bell declared with a literal seed (no live drand, O-M1-12), the real expedition wrapper (ExpeditionDepart, SettleOrigin, ExpeditionReveal, ExpeditionGather, SettleMember) to the Free City's tile and the Free City conquest through the wrapper (DeclareSiege, ResolveWithConquest, …); the UNFILTERED feed; every patch is in `declared`; steps: {}",
            r.log.join("; ")
        ),
        "playable-expedition-whole",
    );
    whole.declared = r.declared.clone();
    for l in &r.log {
        println!("STEP {l}");
    }
    let mut judged = whole.clone();
    judged.program_so = Some(std::sync::Arc::new(so.clone()));
    let rep = verify_core::verify(&judged);
    for f in &rep.findings {
        println!(
            "whole {:?} {} {} {} {}",
            f.severity,
            f.check,
            f.code,
            f.entity,
            f.detail.chars().take(300).collect::<String>()
        );
    }
    println!("whole verdict {:?}", rep.verdict);
    if let Ok(dir) = std::env::var("PLAYABLE_EXPEDITION_DUMP") {
        let d = std::path::PathBuf::from(dir);
        whole
            .save(&d.join("playable-expedition-whole.json.gz"))
            .expect("save");
        println!("saved to {}", d.display());
    }
}

// ------------------------------------------------------------ helpers of the expedition

/// When THE anchor of `bell` lands: 5 s after T(bell) is due
/// (`playable_march.rs`).
fn anchor_ts(sd: &[u8], bell: u32) -> i64 {
    let (clock, _, _, genesis_ts) = clock_of(sd);
    round_time(
        clock.genesis,
        clock.period as u32,
        kb::tlock_round(&clock, genesis_ts, bell),
    ) + 5
}

/// **Declared patch**: THE anchor of `(bell, region)` as PostAnchor leaves
/// it (round T(bell), landed at [`anchor_ts`]), as `playable_march.rs`.
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
        ctx.bell_anchor(bell, region),
        ad,
        &format!("BellAnchor(bell {bell}, region {region}), round T(bell)"),
    );
}

/// **Declared patch**: the SeedCache of `(bell, region)` (nonce 0) with a
/// literal seed, over THE anchor present, as `playable_march.rs`.
fn patch_seed(r: &mut Rec, bell: u32, region: u8) {
    let ctx = ctx_of(&r.a);
    let sd = r.data(&r.a.season).expect("season");
    let (clock, sched, margin, _) = clock_of(&sd);
    let anchor_key = ctx.bell_anchor(bell, region);
    let ad = r.data(&adr(anchor_key)).expect("THE anchor");
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
    cd[SC::SEED..SC::SEED + 32].copy_from_slice(&seed_of(bell));
    cd[SC::ANCHOR_KEY..SC::ANCHOR_KEY + 32].copy_from_slice(&anchor_key);
    cd[SC::A..SC::A + 8].copy_from_slice(&a_ts.to_le_bytes());
    r.patch(
        ctx.seed_cache(bell, region, 0),
        cd,
        &format!("SeedCache(bell {bell}, region {region}, nonce 0), literal seed"),
    );
}

/// The reveal close of THE anchor of `(bell, region)` present on chain.
fn anchor_close(r: &Rec, bell: u32, region: u8) -> i64 {
    let sd = r.data(&r.a.season).expect("season");
    let (_, sched, _, _) = clock_of(&sd);
    let ad = r.data(&r.a.anchor(bell, region)).expect("THE anchor");
    let a_ts = i64::from_le_bytes(ad[BA::A..BA::A + 8].try_into().unwrap());
    kb::reveal_close(a_ts, kb::window(&sched, bell))
}

/// The STRONG host (whole troops ×1000): 3,000, ten times FRONTIER_7's
/// Free City garrison (300), under `MAX_HOST_TROOPS` (30,000); as
/// `itest::conquest_real`'s explicitly strong fixture.
const STRONG_TROOPS: u32 = 3_000_000;
/// A shipped fixture round (`fclient/fixtures/quicknet`), the genesis.
const GENESIS_ROUND: u64 = 32_551_749;
/// The arrival bell: T(21) = GENESIS_ROUND + 200 · (21 + 2).
const ARRIVE_BELL: u32 = 21;
/// T(21): the S-TLOCK q4 vector's previous round, a real quicknet round.
const ARRIVE_ROUND: u64 = 32_556_349;

/// The real signature of `ARRIVE_ROUND` (q4's `prev_round_sig`).
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
/// The host's unit (as `itest::expedition_play`'s fixture).
const UNIT: u8 = 2;

fn meta(k: Address, signer: bool, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(k, signer)
    } else {
        AccountMeta::new_readonly(k, signer)
    }
}

fn resolved_next_of(r: &Rec, coord: WideCoord) -> u32 {
    resolved_next(r, coord)
}

/// The legacy keeper steps of `(p, q)`'s bell `b` (as `playable_march.rs`):
/// THE anchor declared (anchored 100 s into the bell), SkipQuiet, or else
/// GatherClash over every position, a declared SeedCache and
/// ResolveFromInputs.
fn legacy_resolve(r: &mut Rec, keeper: &Keypair, p: i16, q: i16, b: u32) {
    let a = r.a.clone();
    let region = ix::region_of(p.into(), q.into());
    if r.data(&a.anchor(b, region)).is_none() {
        patch_anchor(r, b, region);
        patch_seed(r, b, region);
    }
    let close = anchor_close(r, b, region);
    if r.c.unix_timestamp() < close + 1 {
        r.advance_to(close + 1);
    }
    if r.try_send(
        &[keeper],
        &[ix::skip_quiet(
            &a,
            keeper.pubkey(),
            (p.into(), q.into()),
            b,
            1,
            &[ix::AnchorSource::Anchor],
        )],
        &format!("SkipQuiet ({p},{q}) bell {b}"),
    ) {
        return;
    }
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
            ix::AnchorSource::Anchor,
            0,
            &positions,
            &holdings,
            bitmap,
            &keeper.pubkey(),
        )],
        &format!("GatherClash ({p},{q}) bell {b}"),
    );
    r.send(
        &[keeper],
        &[ix::resolve_from_inputs(
            &a,
            keeper.pubkey(),
            dest,
            b,
            ix::SeedSource::Cache { nonce: 0 },
            &keeper.pubkey(),
        )],
        &format!("ResolveFromInputs ({p},{q}) bell {b}"),
    );
}

/// The program's masks of one province (`PASSABLE`, `ROUGH`, `ROAD`), as
/// `itest::destination_real`.
#[derive(Clone, Copy, Debug)]
struct Masks {
    key: ProvinceKey,
    passable: u64,
    rough: u64,
}

fn masks_of(key: ProvinceKey, data: &[u8]) -> Masks {
    use frontier_abi::v2::layout::province::province as P2;
    let u = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Masks {
        key,
        passable: u(P2::PASSABLE_MASK),
        rough: u(P2::ROUGH_MASK),
    }
}

/// A derived route (`itest::destination_real::Route`).
struct Route {
    dirs: Vec<u8>,
    dest_tile: u8,
    keys: Vec<ProvinceKey>,
    steps: Vec<TileAddress>,
}

/// `itest::destination_real::derive_route_to`: the shortest route from
/// `origin` onto `tile` of `dest` over the passable tiles of `lands`.
fn derive_route_to(
    origin: TileAddress,
    dest: ProvinceKey,
    lands: &[Masks],
    tile: Option<u8>,
) -> Option<Route> {
    use permutation_rules::frontier::travel::{MAX_PATH_PROVINCES, MAX_PATH_STEPS};
    let passable = |t: &WideTile| {
        lands
            .iter()
            .any(|l| l.key == t.province() && l.passable & (1u64 << t.local()) != 0)
    };
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
    Some(Route {
        dest_tile: tiles.last()?.local(),
        dirs,
        keys,
        steps: tiles.iter().map(|s| s.address()).collect(),
    })
}

/// `itest::destination_real::travel_upper`: the slowest faction's travel
/// seconds over `steps`.
fn travel_upper(steps: &[TileAddress], lands: &[Masks]) -> u32 {
    let raw: u32 = steps
        .iter()
        .map(|s| {
            let l = lands
                .iter()
                .find(|l| l.key == s.key())
                .expect("a stepped province");
            if l.rough & (1u64 << s.local()) != 0 {
                permutation_rules::frontier::travel::ROUGH_HEX_SECS
            } else {
                permutation_rules::frontier::travel::FLAT_HEX_SECS
            }
        })
        .sum();
    (0..6u8)
        .filter_map(permutation_rules::frontier::doctrine::of_faction_v3)
        .map(|d| d.travel_secs(raw as u64) as u32)
        .max()
        .expect("a doctrine")
}

/// The player's ExpeditionReveal (kind 2): `wide_ix::REVEAL`'s sixteen
/// accounts, then the route's path provinces (`itest::destination_real::reveal_ix`).
#[allow(clippy::too_many_arguments)]
fn reveal_ix(
    ctx: &AddrCtx,
    payer: &Address,
    holding: &Address,
    slot: u8,
    faction: u8,
    arrive: u32,
    region: u8,
    dest: ProvinceKey,
    sealed: &fclient::wide_seal::WideSealed,
    target: u8,
    route: &Route,
) -> Instruction {
    let inner = wix::ExpeditionReveal {
        transit_slot: slot,
        target_i: target,
        plain: *sealed.reveal.plain(),
        salt: *sealed.reveal.salt(),
        ct_hash: sealed.ct_hash,
        beneficiary: payer.to_bytes(),
    };
    let data = dx::encode(dx::Kind::Reveal, &inner.to_bytes()).expect("a Reveal wire");
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(adr(ctx.season), false),
        AccountMeta::new_readonly(*holding, false),
        AccountMeta::new_readonly(adr(transit_address(ctx, &holding.to_bytes(), slot)), false),
        AccountMeta::new_readonly(adr(ctx.bell_anchor(arrive, region)), false),
        AccountMeta::new_readonly(
            adr(ctx.anchor_archive(region, archive_part_of(arrive))),
            false,
        ),
        AccountMeta::new_readonly(adr(ctx.beacon_log(region)), false),
        AccountMeta::new_readonly(adr(wa::clash_inputs_address(ctx, dest, arrive)), false),
        AccountMeta::new_readonly(adr(wl::province_address(ctx, dest.coord())), false),
        AccountMeta::new(
            adr(wa::arrival_day_address(ctx, dest, wa::day_of(arrive))),
            false,
        ),
    ];
    for i in 0..4u8 {
        let k = adr(wa::arrival_slot_address(ctx, dest, arrive, faction, i));
        m.push(if i == target {
            AccountMeta::new(k, false)
        } else {
            AccountMeta::new_readonly(k, false)
        });
    }
    m.push(AccountMeta::new_readonly(
        fclient::addr::instructions_sysvar(),
        false,
    ));
    m.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    assert_eq!(m.len(), wix::REVEAL_FIXED);
    let resolver = AccountResolver::for_season(ctx).expect("a resolver");
    for k in &route.keys[1..] {
        m.push(AccountMeta::new_readonly(
            adr(resolver
                .province_address(*k)
                .expect("a path province address")),
            false,
        ));
    }
    Instruction {
        program_id: adr(ctx.program),
        accounts: m,
        data,
    }
}

/// ExpeditionGather (kind 3) of every position of `bell` at `dest`
/// (`itest::destination_driver::gather_ix` over positions 0..24).
fn gather_ix(
    r: &Rec,
    payer: &Address,
    dest: ProvinceKey,
    dest_key: Address,
    region: u8,
    bell: u32,
) -> Instruction {
    let ctx = ctx_of(&r.a);
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(r.a.season, false),
        AccountMeta::new_readonly(dest_key, false),
        AccountMeta::new_readonly(r.a.anchor(bell, region), false),
        AccountMeta::new(adr(wa::clash_inputs_address(&ctx, dest, bell)), false),
        AccountMeta::new_readonly(
            adr(wa::arrival_day_address(&ctx, dest, wa::day_of(bell))),
            false,
        ),
        AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    let filler = fclient::addr::system_program();
    let positions = 4 * fclient::abi::FACTIONS;
    for k in 0..positions {
        let slot = adr(wa::arrival_slot_address(&ctx, dest, bell, k / 4, k % 4));
        match r.c.account(&slot) {
            None => {
                m.push(AccountMeta::new_readonly(slot, false));
                m.push(AccountMeta::new_readonly(filler, false));
                m.push(AccountMeta::new_readonly(filler, false));
            }
            Some(acc) => {
                let s = ExpeditionArrivalSlot::read(&ctx, &acc.data).expect("a slot");
                let holding = AccountResolver::for_season(&ctx)
                    .unwrap()
                    .holding_address(&s.common().host)
                    .unwrap();
                let ext = transit_address(&ctx, &holding, s.common().transit_slot);
                m.push(AccountMeta::new_readonly(slot, false));
                m.push(AccountMeta::new_readonly(adr(holding), false));
                m.push(AccountMeta::new(adr(ext), false));
            }
        }
    }
    Instruction {
        program_id: r.a.program,
        accounts: m,
        data: dx::encode(
            dx::Kind::Gather,
            &wix::ExpeditionGather {
                bell,
                start: 0,
                n: positions,
            }
            .to_bytes(),
        )
        .unwrap(),
    }
}

/// ResolveWithConquest (kind 13; `itest::conquest_crank::resolve_with_conquest_ix`).
fn rwc_ix(
    a: &Addresses,
    payer: &Address,
    dest: ProvinceKey,
    dest_key: Address,
    region: u8,
    bell: u32,
) -> Instruction {
    let ctx = ctx_of(a);
    Instruction {
        program_id: a.program,
        data: dx::encode(
            dx::Kind::ResolveWithConquest,
            &wix::ResolveWithConquest {
                bell,
                beneficiary: payer.to_bytes(),
            }
            .to_bytes(),
        )
        .unwrap(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(dest_key, false),
            AccountMeta::new(adr(wro::roster_address(&ctx, dest)), false),
            AccountMeta::new_readonly(a.seed_cache(bell, region, 0), false),
            AccountMeta::new_readonly(a.anchor(bell, region), false),
            AccountMeta::new(adr(wa::clash_inputs_address(&ctx, dest, bell)), false),
            AccountMeta::new_readonly(
                adr(wa::arrival_day_address(&ctx, dest, wa::day_of(bell))),
                false,
            ),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
            AccountMeta::new(adr(conquest_address(&ctx, dest)), false),
        ],
    }
}

/// The pinned program, committed gzipped (sha256 = `MAIN_SHA256`).
const SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(
        hex::encode(p.sha256()),
        MAIN_SHA256,
        "the committed .so is the pinned one"
    );
    std::sync::Arc::new(p.so.as_ref().clone())
}

// ------------------------------------------------------------ the tests (CI)

use verify_core::{Finding, Report, Severity, Verdict};

const FIXTURE: &str = "playable-expedition-whole.json.gz";

/// The committed recording, with the pinned program given to VX.
fn recorded() -> Input {
    let mut inp = common::fixture(FIXTURE);
    inp.program_so = Some(so());
    inp
}

/// The dispatch kind of transaction `t`'s first program instruction.
fn kind_at(inp: &Input, t: usize) -> Option<dx::Kind> {
    let (data, _) = prog_ix(inp, t)?;
    dx::Command::decode(&data).ok().map(|c| c.kind())
}

/// The data and account keys of transaction `t`'s first program
/// instruction.
fn prog_ix(inp: &Input, t: usize) -> Option<(Vec<u8>, Vec<[u8; 32]>)> {
    let tx = fclient::tx::from_wire(&inp.txs[t].tx).ok()?;
    let m = &tx.message;
    m.instructions
        .iter()
        .find(|ix| m.account_keys.get(ix.program_id_index as usize) == Some(&inp.cfg.program))
        .map(|ix| {
            (
                ix.data.clone(),
                ix.accounts
                    .iter()
                    .map(|&i| m.account_keys[i as usize].to_bytes())
                    .collect(),
            )
        })
}

/// The successful transactions of dispatch kind `k`.
fn of_kind(inp: &Input, k: dx::Kind) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_none() && kind_at(inp, t) == Some(k))
        .collect()
}

fn one(inp: &Input, k: dx::Kind) -> usize {
    let v = of_kind(inp, k);
    assert_eq!(v.len(), 1, "{k:?}: {v:?}");
    v[0]
}

/// The `n`th account of transaction `t`'s program instruction.
fn acct(inp: &Input, t: usize, n: usize) -> Address {
    Address::new_from_array(prog_ix(inp, t).expect("a program instruction").1[n])
}

fn edit_post(inp: &mut Input, t: usize, k: &Address, f: impl FnOnce(&mut Account)) {
    let (_, a) = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x == k)
        .expect("the transaction's post-state of the account");
    f(a.as_mut().expect("present"));
}

fn vx_at(rep: &Report, t: usize) -> Vec<&Finding> {
    let e = format!("tx#{t}");
    rep.findings
        .iter()
        .filter(|f| f.check == "VX" && f.entity == e)
        .collect()
}

fn fails_vx(rep: &Report, t: usize, code: &str) -> bool {
    vx_at(rep, t)
        .iter()
        .any(|f| f.severity == Severity::Fail && f.code == code)
}

fn show(rep: &Report) -> Vec<String> {
    rep.findings
        .iter()
        .filter(|f| f.severity != Severity::Warn)
        .map(|f| {
            format!(
                "{:?} {} {} {} {}",
                f.severity,
                f.check,
                f.code,
                f.entity,
                f.detail.chars().take(160).collect::<String>()
            )
        })
        .collect()
}

#[test]
fn the_committed_program_is_the_pinned_one_and_the_recording_has_the_whole_path() {
    let inp = recorded();
    assert_eq!(
        inp.cfg.program_hash.map(hex::encode).as_deref(),
        Some(MAIN_SHA256)
    );
    use dx::Kind::*;
    for k in [
        Depart,
        SettleOrigin,
        Reveal,
        Gather,
        SettleMember,
        DeclareSiege,
        SettleCapture,
    ] {
        one(&inp, k);
    }
    // the siege's 36 held bells, one ResolveWithConquest each
    assert!(of_kind(&inp, ResolveWithConquest).len() >= 36);
    // in order: depart, origin, reveal, gather, member, declare, resolves, capture
    let order = [
        Depart,
        SettleOrigin,
        Reveal,
        Gather,
        SettleMember,
        DeclareSiege,
    ];
    let at: Vec<usize> = order.iter().map(|k| one(&inp, *k)).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{at:?}");
    assert!(of_kind(&inp, ResolveWithConquest)
        .iter()
        .all(|&t| t > at[5] && t < one(&inp, SettleCapture)));
    // the arrival bell's THE anchor is a REAL PostAnchor (0x10) on q4's previous round
    let posts: Vec<usize> = (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none()
                && prog_ix(&inp, t).is_some_and(|(d, _)| d.first() == Some(&0x10))
        })
        .collect();
    assert_eq!(posts.len(), 1);
    assert!(
        posts[0] > at[2] && posts[0] < at[3],
        "between the Reveal and the Gather"
    );
    // every patch is declared; the feed is unfiltered (wallet posts)
    assert!(!inp.declared.is_empty());
    assert!(inp.provenance.contains("declared"));
    let wallet = |x: &Option<Account>| x.as_ref().is_some_and(|x| x.owner != inp.cfg.program);
    assert!(inp
        .txs
        .iter()
        .any(|t| t.post.iter().any(|(_, x)| wallet(x))));
}

/// What a declared patch explains (the recorder's `set_account`s: the wide
/// land's RingSeed(128) and Frontier, the rim homes, the host, every bell's
/// THE anchor and SeedCache but bell 21's): UNVERIFIABLE, never FAIL.
fn explained(f: &Finding) -> bool {
    let d = &f.detail;
    match f.check {
        "V0E" => d.contains("declares"),
        "VX" => d.contains("only declares"),
        "VWL" => {
            d.contains("bell anchor")
                || d.contains("seed cache")
                || d.contains("RingSeed of ring 128")
                || d.contains("wedge fund")
        }
        "V4" => d.contains("THE anchor"),
        "V11" => d.contains("no seed of ring 128"),
        _ => false,
    }
}

#[test]
fn the_honest_whole_archive_has_no_fail_and_only_its_declared_patches_are_unverifiable() {
    let inp = recorded();
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Unverifiable, "{:#?}", show(&rep));
    for f in &rep.findings {
        assert_ne!(f.severity, Severity::Fail, "{:#?}", show(&rep));
        if f.severity == Severity::Unverifiable {
            assert!(explained(f), "an unexplained finding: {f:?}");
        }
    }
    // nothing of the wrapper is left unmodelled any more
    assert!(
        rep.findings.iter().all(|f| f.code != "WideUnmodelled"),
        "{:#?}",
        show(&rep)
    );
    assert!(rep.checks_run.contains(&"VX:re-execution"));
}

#[test]
fn vx_re_executes_the_expedition_and_the_conquest_exactly() {
    let inp = recorded();
    let rep = verify_core::verify(&inp);
    use dx::Kind::*;
    // re-executed from archived states only: no finding at all
    for k in [
        SettleOrigin,
        Reveal,
        Gather,
        SettleMember,
        DeclareSiege,
        SettleCapture,
    ] {
        let t = one(&inp, k);
        assert!(
            vx_at(&rep, t).is_empty(),
            "{k:?} tx#{t}: {:?}",
            vx_at(&rep, t)
        );
    }
    // the Depart reads the declared host, every ResolveWithConquest a
    // declared THE anchor and SeedCache: exact, and UNVERIFIABLE for that
    for t in std::iter::once(one(&inp, Depart)).chain(of_kind(&inp, ResolveWithConquest)) {
        let v = vx_at(&rep, t);
        assert!(
            v.len() == 1
                && v[0].severity == Severity::Unverifiable
                && v[0].detail.contains("re-executed exactly"),
            "tx#{t}: {v:?}"
        );
    }
}

#[test]
fn without_the_pinned_binary_every_wrapper_transaction_is_unverifiable_never_pass() {
    let mut inp = recorded();
    inp.program_so = None;
    let rep = verify_core::verify(&inp);
    let wrapper: Vec<usize> = (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_none() && kind_at(&inp, t).is_some())
        .collect();
    assert!(wrapper.len() >= 43);
    for &t in &wrapper {
        let v = vx_at(&rep, t);
        assert!(
            v.len() == 1
                && v[0].severity == Severity::Unverifiable
                && v[0].detail.contains("no program binary"),
            "{v:?}"
        );
    }
    // another binary (one byte changed) is not the pinned one
    let mut other = recorded();
    let mut so = other.program_so.take().unwrap().as_ref().clone();
    let n = so.len();
    so[n - 1] ^= 1;
    other.program_so = Some(std::sync::Arc::new(so));
    let rep = verify_core::verify(&other);
    for &t in &wrapper {
        assert!(vx_at(&rep, t).iter().all(
            |f| f.severity == Severity::Unverifiable && f.detail.contains("not the pinned one")
        ));
    }
    // a public RPC's archive (no post-states): nothing to re-execute from
    let mut rpc = recorded();
    for t in &mut rpc.txs {
        t.post.clear();
    }
    let rep = verify_core::verify(&rpc);
    assert_ne!(rep.verdict, Verdict::Pass);
    for &t in &wrapper {
        assert!(
            vx_at(&rep, t)
                .iter()
                .all(|f| f.severity == Severity::Unverifiable),
            "{:?}",
            vx_at(&rep, t)
        );
    }
}

// ---- the expedition wrapper, tampered

#[test]
fn a_forged_transit_record_at_the_depart_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Depart);
    let transit = acct(&inp, t, 8);
    edit_post(&mut inp, t, &transit, |a| a.data[100] ^= 1);
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_forged_arrival_slot_at_the_reveal_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Reveal);
    let slot = acct(&inp, t, wix::REVEAL_SLOT0);
    edit_post(&mut inp, t, &slot, |a| {
        let n = a.data.len();
        a.data[n - 1] ^= 1
    });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_forged_reveal_instruction_fails_its_signature() {
    // the player's sealed plaintext edited in the archived transaction
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Reveal);
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let i = tx
        .message
        .instructions
        .iter()
        .position(|ix| tx.message.account_keys[ix.program_id_index as usize] == inp.cfg.program)
        .unwrap();
    tx.message.instructions[i].data[20] ^= 1;
    inp.txs[t].tx = fclient::tx::wire(&tx);
    let rep = verify_core::verify(&inp);
    assert!(
        vx_at(&rep, t)
            .iter()
            .any(|f| f.severity == Severity::Fail && f.detail.contains("signatures do not verify")),
        "{:#?}",
        vx_at(&rep, t)
    );
}

#[test]
fn a_forged_record_in_the_gathers_logs_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Gather);
    let l = inp.txs[t]
        .logs
        .iter_mut()
        .find(|l| l.starts_with("Program data: "))
        .expect("a record line");
    let last = l.pop().unwrap();
    l.push(if last == 'A' { 'B' } else { 'A' });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn inflated_gathered_troops_fail() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Gather);
    let inputs = acct(&inp, t, 4);
    edit_post(&mut inp, t, &inputs, |a| {
        let n = a.data.len();
        a.data[n / 2] = a.data[n / 2].wrapping_add(1)
    });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_drained_holding_at_the_member_settlement_fails_and_a_gift_does_not() {
    let t = {
        let inp = recorded();
        one(&inp, dx::Kind::SettleMember)
    };
    let mut drained = recorded();
    let h = acct(&drained, t, 1);
    edit_post(&mut drained, t, &h, |a| a.lamports -= 1);
    let rep = verify_core::verify(&drained);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
    // lamports above the re-run's: a System transfer may credit any account
    // outside the archive (never a FAIL a third party can cause)
    // (Only this transaction is judged on the gift: a later transaction
    // naming the Holding would digest its balance in its receipt, and the
    // archived logs were printed without the gift.)
    let mut gift = recorded();
    edit_post(&mut gift, t, &h, |a| a.lamports += 7);
    let rep = verify_core::verify(&gift);
    let v = vx_at(&rep, t);
    assert!(
        v.iter().all(|f| f.severity == Severity::Unverifiable)
            && v.iter().any(|f| f.detail.contains("more lamports")),
        "{v:?}"
    );
}

// ---- the Free City conquest, tampered

#[test]
fn a_siege_declared_without_its_cost_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::DeclareSiege);
    let source = acct(&inp, one(&inp, dx::Kind::Depart), 4);
    edit_post(&mut inp, t, &source, |a| {
        // the Holding's stores region: give the paid arms back
        let o = frontier_abi::v2::layout::player::holding::STORES;
        a.data[o + 1] = a.data[o + 1].wrapping_add(1);
    });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_siege_progress_forged_at_a_resolve_fails() {
    let mut inp = recorded();
    let rs = of_kind(&inp, dx::Kind::ResolveWithConquest);
    let t = rs[rs.len() / 2];
    let table = acct(&inp, t, 9);
    edit_post(&mut inp, t, &table, |a| {
        let n = a.data.len();
        a.data[n - 8] ^= 1
    });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_capture_handed_to_another_citizen_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::SettleCapture);
    let captured = acct(&inp, t, 7);
    edit_post(&mut inp, t, &captured, |a| {
        let o = frontier_abi::v2::layout::player::holding::OWNER_CITIZEN;
        a.data[o] ^= 0xff;
    });
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_capture_before_the_siege_completed_fails() {
    // the last held bell's ResolveWithConquest is not in the archive: the
    // program refuses the capture from the states the archive shows
    let mut inp = recorded();
    let rs = of_kind(&inp, dx::Kind::ResolveWithConquest);
    let gone = *rs.last().unwrap();
    inp.txs.remove(gone);
    for d in &mut inp.declared {
        if d.at > gone {
            d.at -= 1;
        }
    }
    let t = one(&inp, dx::Kind::SettleCapture);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(fails_vx(&rep, t, "ReExecRefused"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_drained_capture_escrow_fails() {
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::SettleCapture);
    let escrow = acct(&inp, t, 6);
    edit_post(&mut inp, t, &escrow, |a| a.lamports -= 1_000);
    let rep = verify_core::verify(&inp);
    assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:#?}", vx_at(&rep, t));
}

#[test]
fn a_mutate_vx_build_judges_nothing() {
    // (the check of the check: `--features mutate-vx` must let the forged
    // transit through VX; asserted only in that build)
    if !cfg!(feature = "mutate-vx") {
        return;
    }
    let mut inp = recorded();
    let t = one(&inp, dx::Kind::Depart);
    let transit = acct(&inp, t, 8);
    edit_post(&mut inp, t, &transit, |a| a.data[100] ^= 1);
    let rep = verify_core::verify(&inp);
    assert!(vx_at(&rep, t).is_empty());
}
