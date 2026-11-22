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
//! verifier-coverage (2026-11-20): seven more recordings of the same
//! season, `playable-cov-*.json.gz` (`record_playable_coverage`, one per
//! [`Sc`] scenario), cover the dispatch kinds the main one does not:
//! SettleCamp (7), SettleFailure (8), SettleForfeit (9), CloseTerminal (10),
//! SettleRetainedFailure (11), SettleSiege (15) and SettleReservation (18),
//! and the wide-native host lifecycle VX now re-executes: WideDissolve,
//! WideReturn, WideDisbandStranded and WideCloseRoster. All are real
//! transactions of the pinned program, except that kinds 8 and 9 start from
//! one declared patch no real path avoids (the arrival slot made absent;
//! kind 8 also the fate DESTROYED), so they stay UNVERIFIABLE.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_EXPEDITION_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_expedition -- --ignored --nocapture`
//! (`PLAYABLE_SC=Siege,Camp` records only those coverage scenarios.)
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
    // (the committed recordings were made while the preset's `outpost_tier_min` was 1 = Town; Q-W1 made it 0 on
    //  2026-11-20. The recorder keeps the recorded byte so a re-recording reproduces them.)
    p.cq.outpost_tier_min = 1;
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
    /// A local land `.so` (`PSF_LOCAL_LAND`), whose WideDepart runs.
    local: bool,
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
    /// verifier-coverage-2: an instruction the pinned program must REFUSE
    /// with `code` (archived as a failed transaction, as a chain shows it).
    fn refused(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str, code: u32) {
        let (bh, _) = self.c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &bh).expect("build");
        let sig = self.c.submit(&tx::wire(&t)).expect("lands (as a failure)");
        self.c.produce_block();
        let l = self.c.transaction(&sig).cloned().expect("landed");
        self.last_logs = l.logs.clone();
        self.log.push(format!(
            "PROBE {what}: refused {:?} code {:?}",
            l.err, l.code
        ));
        assert!(
            l.err.is_some() && l.code == Some(code),
            "{what}: want code {code}, got {:?} {:?}: {:#?}",
            l.err,
            l.code,
            l.logs
        );
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

/// verifier-coverage-2: program error codes the probes expect.
const BAD_ACCOUNT: u32 = frontier_abi::error::FrontierError::BadAccount as u32;
const NOT_IMPLEMENTED: u32 = frontier_abi::error::FrontierError::NotImplemented as u32;

/// The RAW (non-envelope) form of a dispatch-envelope instruction: the
/// inner wide command alone (`[tag, 0xff, 2, kind] ++ inner` → `inner`).
fn raw_of(ix: &Instruction) -> Instruction {
    let inner = ix.data[dx::HEADER_LEN..].to_vec();
    assert!(
        wix::WideCommand::decode(&inner).is_ok(),
        "the inner bytes are a whole wide command"
    );
    Instruction {
        program_id: ix.program_id,
        accounts: ix.accounts.clone(),
        data: inner,
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
        chain: Default::default(),
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
    record(Sc::Main);
}

/// verifier-coverage (2026-11-20): one small recording per remaining
/// dispatch kind and for the wide-native host lifecycle, each branching off
/// the same season as [`record_playable_expedition`] (module doc of
/// [`Sc`]).
#[test]
#[ignore = "needs the devnet-playable .so built from main: set PSF_PLAYABLE_SO (sha256 da3dc1aa…), run with --ignored"]
fn record_playable_coverage() {
    // (`PLAYABLE_SC=Siege,Terminal` records only those)
    let only = std::env::var("PLAYABLE_SC").ok();
    for sc in Sc::COVERAGE {
        if only
            .as_deref()
            .is_none_or(|o| o.split(',').any(|x| x == format!("{sc:?}")))
        {
            record(sc);
        }
    }
}

/// The recorder's scenarios. `Main` is the recording of #89/#91
/// (`playable-expedition-whole`); the others (verifier-coverage) branch off
/// the same season:
///
/// * `Siege`: SettleMember, DeclareSiege, the host's **Dissolve** (kind 4)
///   while its siege runs, ResolveWithConquest until the siege FAILS (site
///   record kind NONE), **SettleSiege** (15); a second DeclareSiege while
///   the province's resolve cursor lags (a reservation) whose host has left,
///   ResolveWithConquest until it is NOT_APPLIED, **SettleReservation**
///   (18); the leave bell, Return (5). All real.
/// * `Retained`: the Depart's seal with one BODY byte flipped (its flag
///   byte stays valid, so Depart takes it; `ct_hash` and the root over the
///   flipped bytes), Reveal, Gather, the arrival's WideResolve (fate
///   STAYS), then **SettleRetainedFailure** (11): the seal does not open.
///   All real.
/// * `Forfeit` / `Failure`: as `Retained`, then ONE **declared** patch the
///   program cannot reach (the canonical arrival slot made absent; for
///   `Failure` also the row's fate DESTROYED: no real path leaves a row
///   whose slot is gone, `expedition_close::close_slot` has no non-test
///   caller), then **SettleForfeit** (9) / **SettleFailure** (8). VX
///   re-executes them exactly and reports them UNVERIFIABLE for the patch,
///   never PASS.
/// * `Terminal`: the Depart and SettleOrigin, never revealed; EndSeason,
///   the 72 h grace, **CloseTerminal** (10). All real.
/// * `WideHost`: the closed wide host lifecycle in the wide land: player
///   1's WideClaimSite, WideSettleTicket, WideFinalize, a declared reserve
///   (as `playable_wide_march.rs`'s patch 4), WideMuster, WideResolve,
///   **WideDissolve**, the leave bell, **WideReturn**; a second WideMuster
///   left standing; EndSeason, the grace, WideClose of the holding,
///   **WideDisbandStranded** of the stranded entry, **WideCloseRoster**.
/// * `Camp`: a valid expedition onto the destination's camp, then
///   **SettleCamp** (7), when the destination has a live camp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sc {
    Main,
    Siege,
    Retained,
    Forfeit,
    Failure,
    Terminal,
    WideHost,
    Camp,
    Closes,
    WideRaw,
}

impl Sc {
    const COVERAGE: [Sc; 9] = [
        Sc::Siege,
        Sc::Retained,
        Sc::Forfeit,
        Sc::Failure,
        Sc::Terminal,
        Sc::WideHost,
        Sc::Camp,
        Sc::Closes,
        Sc::WideRaw,
    ];
    fn fixture(self) -> &'static str {
        match self {
            Sc::Main => "playable-expedition-whole.json.gz",
            Sc::Siege => "playable-cov-siege.json.gz",
            Sc::Retained => "playable-cov-retained.json.gz",
            Sc::Forfeit => "playable-cov-forfeit.json.gz",
            Sc::Failure => "playable-cov-failure.json.gz",
            Sc::Terminal => "playable-cov-terminal.json.gz",
            Sc::WideHost => "playable-cov-widehost.json.gz",
            Sc::Camp => "playable-cov-camp.json.gz",
            Sc::Closes => "playable-cov-closes.json.gz",
            Sc::WideRaw => "playable-cov-wideraw.json.gz",
        }
    }
    fn bad_seal(self) -> bool {
        matches!(self, Sc::Retained | Sc::Forfeit | Sc::Failure)
    }
}

fn record(sc: Sc) {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    // verifier-coverage-2: `PSF_LOCAL_LAND=1` runs `Sc::WideRaw` on a LOCAL
    // land `.so` (`localnet-land-sbf`, WideDepart's debit gate open since
    // #94): evidence only, never a committed fixture.
    let local = std::env::var("PSF_LOCAL_LAND").is_ok();
    if local {
        assert_eq!(sc, Sc::WideRaw, "PSF_LOCAL_LAND is for Sc::WideRaw only");
    } else {
        assert_eq!(
            hex::encode(so_hash),
            MAIN_SHA256,
            "not the devnet-playable build of main (da3dc1aa)"
        );
    }
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
        local,
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
    // verifier-coverage (`Sc::Camp`): the opened provinces' camps.
    use frontier_abi::layout::province::camp as CM;
    let camps: Vec<(WideCoord, u8, u8, u32)> = opened
        .iter()
        .filter_map(|&coord| {
            let d = r.data(&adr(wl::province_address(&ctx, coord)))?;
            let o = PV::CAMP;
            let troops =
                u32::from_le_bytes(d[o + CM::TROOPS..o + CM::TROOPS + 4].try_into().unwrap());
            Some((coord, d[o + CM::STATE], d[o + CM::TILE], troops))
        })
        .collect();
    r.log.push(format!(
        "the opened provinces' camps (coord, state, tile, troops): {camps:?}"
    ));
    let (dest_coord, fc_tile) = match (sc, camps.iter().find(|c| c.1 == CM::STATE_PRESENT)) {
        (Sc::Camp, Some(c)) => (c.0, c.2),
        (Sc::Camp, None) => {
            println!("SKIP Sc::Camp: no opened province has a live camp at the departure");
            return;
        }
        _ => (dest_coord, fc_tile),
    };
    let dest = ProvinceKey::new(world, dest_coord);
    let dest_key = adr(wl::province_address(&ctx, dest_coord));
    let region = WideProvince::read(&r.data(&dest_key).unwrap())
        .unwrap()
        .region;
    r.log.push(format!(
        "destination {dest_coord:?} (region {region}): Free City at site {fc_site}, tile {fc_tile}"
    ));
    if sc == Sc::WideHost || sc == Sc::WideRaw {
        let keeper = Keypair::new_from_array([0xA3; 32]);
        r.c.airdrop(&keeper.pubkey(), 100_000_000_000).unwrap();
        r.c.produce_block();
        wide_host(
            &mut r,
            &members[1],
            &opened,
            &payer,
            &keeper,
            sc == Sc::WideRaw,
        );
        finish(&r, sc, program, so_hash, &so, &upgrade);
        return;
    }
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
    let mut sealed = sealed;
    if sc.bad_seal() {
        // verifier-coverage: a seal that does not open. The flag byte stays
        // valid (Depart's `seal_flag_ok`), one BODY byte flips; the
        // ciphertext hash and the root are over the flipped bytes, so Depart
        // stores them and Reveal (plain, salt, ct_hash against the root)
        // takes them. Only the settlement opens the seal.
        use frontier_abi::world_index::seal as wsl;
        let n = sealed.seal.len() - 1;
        sealed.seal[n] ^= 1;
        sealed.ct_hash = wsl::ct_hash(&sealed.seal);
        sealed.seal_root = wsl::seal_root(&sealed.commit, &sealed.ct_hash);
        r.log
            .push("the seal's last body byte flipped (a seal that does not open)".into());
    }
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
    if sc == Sc::Closes {
        // verifier-coverage-2: the RAW (non-envelope) form of each expedition
        // command is refused by EXPEDITION_ENABLED before anything is read.
        r.refused(
            &[&wallet0],
            &[raw_of(&depart)],
            "raw ExpeditionDepart (EXPEDITION_ENABLED)",
            NOT_IMPLEMENTED,
        );
    }
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
    if sc == Sc::Closes {
        r.refused(
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
                data: wix::ExpeditionSettleOrigin { transit_slot: 0 }
                    .to_bytes()
                    .to_vec(),
            }],
            "raw ExpeditionSettleOrigin (EXPEDITION_ENABLED)",
            NOT_IMPLEMENTED,
        );
    }
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
    if sc == Sc::Terminal {
        // verifier-coverage: the transit is never revealed. At the Season's
        // end (EndSeason, the 72 h grace) the bridge closes by
        // **CloseTerminal** (kind 10): `[season, holding, external, rent_to]`.
        let rent_to = OwnedBridgeTransit::from_bytes(&ctx, &r.data(&external).unwrap())
            .unwrap()
            .transit()
            .rent_to;
        end_season(&mut r, &keeper);
        let ix = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(h0), false),
                AccountMeta::new(external, false),
                AccountMeta::new(adr(rent_to), false),
            ],
            data: dx::encode(
                dx::Kind::CloseTerminal,
                &frontier_abi::world_index::expedition_terminal_ix::DraftCommand::new(0)
                    .unwrap()
                    .to_bytes(),
            )
            .unwrap(),
        };
        r.send(&[&keeper], &[ix], "CloseTerminal");
        finish(&r, sc, program, so_hash, &so, &upgrade);
        return;
    }

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
    if sc == Sc::Closes {
        r.refused(
            &[&wallet0],
            &[raw_of(&rev)],
            "raw ExpeditionReveal (EXPEDITION_ENABLED)",
            NOT_IMPLEMENTED,
        );
    }
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
    if sc == Sc::Closes {
        r.refused(
            &[&keeper],
            &[raw_of(&gather)],
            "raw ExpeditionGather (EXPEDITION_ENABLED)",
            NOT_IMPLEMENTED,
        );
    }
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
    if sc == Sc::Closes {
        // verifier-coverage-2: the expedition's arrival slot is the v2
        // representation (`ExpeditionArrivalSlot`); the native WideClaimDefence
        // and WideClose(2) read only v1 (`WideArrivalSlot::read`), so both
        // refuse it BadAccount, and no v1 slot exists in this lane (only the
        // raw WideReveal writes one, from a WideDepart transit record).
        let day = frontier_abi::addr::day_of(bell_now(&r));
        let beneficiary = sl.common().beneficiary;
        r.log.push(format!(
            "the v2 slot's beneficiary is the keeper: {}",
            beneficiary == keeper.pubkey().to_bytes()
        ));
        r.refused(
            &[&keeper],
            &[wide_ix(
                &a,
                vec![
                    AccountMeta::new(keeper.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(a.defence_pool(), false),
                    AccountMeta::new(
                        adr(ctx.defence_claim(&keeper.pubkey().to_bytes(), day)),
                        false,
                    ),
                    AccountMeta::new_readonly(fclient::addr::system_program(), false),
                    AccountMeta::new(slot_k, false),
                    AccountMeta::new_readonly(a.anchor(arrive, region), false),
                ],
                wix::ClaimDefence { day, n: 1 }
                    .to_bytes()
                    .expect("n in 1..=6")
                    .to_vec(),
            )],
            "WideClaimDefence of the expedition's v2 arrival slot",
            BAD_ACCOUNT,
        );
        r.refused(
            &[&keeper],
            &[wide_ix(
                &a,
                vec![
                    AccountMeta::new_readonly(keeper.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(slot_k, false),
                    AccountMeta::new(adr(sl.common().rent_to), false),
                ],
                wix::Close {
                    what: wix::CLOSE_WHAT_SLOT,
                }
                .to_bytes()
                .to_vec(),
            )],
            "WideClose(2) of the expedition's v2 arrival slot",
            BAD_ACCOUNT,
        );
    }
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
    if sc.bad_seal() {
        // verifier-coverage: the seal does not open. Kind 11 with the arrival
        // slot present (real); kinds 9 / 8 need the slot absent, which no
        // real transaction leaves beside a row (declared patch).
        let roster_k = adr(wro::roster_address(&ctx, dest));
        let mut accounts = settle.accounts.clone();
        let (kind, inner) = match sc {
            Sc::Retained => {
                accounts.push(AccountMeta::new_readonly(roster_k, false));
                (
                    dx::Kind::SettleRetainedFailure,
                    frontier_abi::world_index::expedition_retained_failure_ix::DraftCommand::new(
                        0,
                        sealed.commit,
                        sealed.seal,
                    )
                    .unwrap()
                    .to_bytes()
                    .to_vec(),
                )
            }
            Sc::Forfeit => {
                absent_slot(&mut r, slot_k);
                accounts.push(AccountMeta::new_readonly(roster_k, false));
                (
                    dx::Kind::SettleForfeit,
                    frontier_abi::world_index::expedition_forfeit_ix::DraftCommand::new(
                        0,
                        sealed.commit,
                        sealed.seal,
                    )
                    .unwrap()
                    .to_bytes()
                    .to_vec(),
                )
            }
            _ => {
                absent_slot(&mut r, slot_k);
                r.edit(
                    inputs_k.to_bytes(),
                    &format!("the ClashInputs row of position {position}: fate DESTROYED"),
                    |d| {
                        let mut x = WideArrival::read_at(d, position).unwrap().unwrap();
                        x.fate = frontier_abi::world_index::arrival::wide_arrival::FATE_DESTROYED;
                        x.write_at(d, position).unwrap();
                    },
                );
                (
                    dx::Kind::SettleFailure,
                    frontier_abi::world_index::expedition_failure_ix::DraftCommand::new(
                        0,
                        sealed.commit,
                        sealed.seal,
                    )
                    .unwrap()
                    .to_bytes()
                    .to_vec(),
                )
            }
        };
        // (SettleMember itself refuses the seal: archived as a failure)
        r.try_send(
            &[&keeper],
            std::slice::from_ref(&settle),
            "SettleMember of a seal that does not open (refused)",
        );
        let ix = Instruction {
            program_id: program,
            accounts,
            data: dx::encode(kind, &inner).unwrap(),
        };
        r.send(&[&keeper], &[ix], &format!("{kind:?}"));
        finish(&r, sc, program, so_hash, &so, &upgrade);
        return;
    }
    if sc == Sc::Camp {
        // verifier-coverage: the host holds the camp's tile (`camp_mask`):
        // SettleMember refuses a camp winner, **SettleCamp** (kind 7) pays the
        // camp's loot to the original owner's Citizen (the 15th account).
        let ih = WideClashInputsHdr::read(&r.data(&inputs_k).unwrap()).unwrap();
        r.log
            .push(format!("the ClashInputs' camp_mask: {:#x}", ih.camp_mask));
        r.try_send(
            &[&keeper],
            std::slice::from_ref(&settle),
            "SettleMember of the camp winner (refused)",
        );
        let mut accounts = settle.accounts.clone();
        accounts.push(AccountMeta::new(adr(m0.citizen), false));
        let ix = Instruction {
            program_id: program,
            accounts,
            data: dx::encode(
                dx::Kind::SettleCamp,
                &frontier_abi::world_index::expedition_settlement_ix::camp_v2::DraftCommand::new(
                    0,
                    sealed.commit,
                    sealed.seal,
                )
                .unwrap()
                .to_bytes(),
            )
            .unwrap(),
        };
        r.send(&[&keeper], &[ix], "SettleCamp");
        finish(&r, sc, program, so_hash, &so, &upgrade);
        return;
    }
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
        if sc == Sc::Closes {
            r.refused(
                &[&wallet0],
                &[raw_of(&ix)],
                "raw DeclareSiege (CONQUEST_LIFECYCLE_ENABLED)",
                NOT_IMPLEMENTED,
            );
        }
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
    // verifier-coverage (`Sc::Siege`): the bell the host left while its
    // siege ran (Dissolve, kind 4).
    let mut siege_left: Option<u32> = None;
    let mut raw_rwc = false;
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
            if sc == Sc::Closes && !raw_rwc {
                raw_rwc = true;
                r.refused(
                    &[&keeper],
                    &[raw_of(&rwc_ix(
                        &a,
                        &keeper.pubkey(),
                        dest,
                        dest_key,
                        region,
                        b,
                    ))],
                    "raw ResolveWithConquest (CONQUEST_LIFECYCLE_ENABLED)",
                    NOT_IMPLEMENTED,
                );
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
                if sc == Sc::Siege && siege_left.is_none() && e.rules.progress >= 1 {
                    // the host leaves while its siege runs: the siege fails at
                    // the bell after its leave bell (the attacker no longer holds)
                    let ix = dissolve_ix(&ctx, program, host0, dest, w0);
                    if r.try_send(&[&wallet0], &[ix], "Dissolve while the siege runs") {
                        siege_left = Some(bell_now(&r));
                    } else {
                        let tail: Vec<_> =
                            r.last_logs.iter().rev().take(6).rev().cloned().collect();
                        r.log.push(format!("Dissolve tail: {tail:?}"));
                    }
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
        if sc == Sc::Closes {
            r.refused(
                &[&keeper],
                &[raw_of(&capture)],
                "raw SettleCapture (CONQUEST_LIFECYCLE_ENABLED)",
                NOT_IMPLEMENTED,
            );
        }
        if sc == Sc::Siege || !r.try_send(&[&keeper], &[capture], "SettleCapture") {
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

    // ---- 10b. (verifier-archive-next) The host leaves the destination and
    // goes home: **Dissolve** (kind 4, the player's) once the province's
    // bells caught up, the destination resolved past the leave bell, then
    // the permissionless **Return** (kind 5). Then the Season's end
    // (EndSeason, 72 h grace) and the Free City's closes:
    // **CloseCaptureEscrow** (17) and **CloseConquest** (16).
    let bell_now = |r: &Rec| -> u32 {
        let sd = r.data(&r.a.season).unwrap();
        let (_, _, _, g) = clock_of(&sd);
        ((r.c.unix_timestamp() - g) / 600) as u32
    };
    let rwc_once = |r: &mut Rec| {
        let b = resolved_next_of(r, dest_coord);
        if r.c.account(&adr(ctx.bell_anchor(b, region))).is_none() {
            stage_seed(r, b, region, seed_of(b));
        }
        let close = window_close(r, b);
        if r.c.unix_timestamp() < close + 1 {
            r.advance_to(close + 1);
        }
        r.send(
            &[&keeper],
            &[rwc_ix(
                &r.a.clone(),
                &keeper.pubkey(),
                dest,
                dest_key,
                region,
                b,
            )],
            &format!("ResolveWithConquest bell {b}"),
        );
    };
    use fclient::wide_resident_draft::Draft as ResidentDraft;
    let mut dissolved = None;
    for _ in 0..40 {
        if resolved_next_of(&r, dest_coord) + 1 >= bell_now(&r) {
            break;
        }
        rwc_once(&mut r);
    }
    if sc == Sc::Siege {
        // verifier-coverage: the host left already. A second DeclareSiege of
        // the site while the province's resolve cursor lags is a
        // RESERVATION; at its bell the host is no longer on the roster, so
        // it is NOT_APPLIED, and **SettleReservation** (kind 18) returns it.
        dissolved = siege_left;
        let rn = resolved_next_of(&r, dest_coord);
        let sd = r.data(&a.season).unwrap();
        let (_, _, _, g) = clock_of(&sd);
        r.advance_to(g + 600 * (rn as i64 + 1) + 1);
        if let Some(entry) = entry {
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
            if !r.try_send(
                &[&wallet0],
                &[ix],
                &format!("DeclareSiege of site {fc_site} while the cursor lags (a reservation)"),
            ) {
                let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
                r.log.push(format!("reservation tail: {tail:?}"));
            }
        }
        let not_applied = |r: &Rec| {
            WideConquest::read(&r.data(&conquest_k)?, SEASON_ID, dest)
                .ok()?
                .reservations()
                .iter()
                .flatten()
                .find(|x| x.status == frontier_abi::world_index::conquest::RES_NOT_APPLIED)
                .copied()
        };
        for _ in 0..6 {
            if not_applied(&r).is_some() {
                break;
            }
            rwc_once(&mut r);
        }
        if let Some(res) = not_applied(&r) {
            let escrow_k = adr(capture_escrow_address(&ctx, &res.citizen));
            let funder = r
                .data(&escrow_k)
                .and_then(|d| WideCaptureEscrow::read(&d, SEASON_ID, world, res.citizen).ok())
                .map(|e| adr(e.funder()))
                .unwrap_or(keeper.pubkey());
            let source = adr(resolver.holding_address(&res.source()).unwrap());
            let ix = Instruction {
                program_id: program,
                data: dx::encode(
                    dx::Kind::SettleReservation,
                    &wix::SettleReservation { seq: res.seq }.to_bytes(),
                )
                .unwrap(),
                accounts: vec![
                    AccountMeta::new_readonly(keeper.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(dest_key, false),
                    AccountMeta::new(conquest_k, false),
                    AccountMeta::new(adr(res.citizen), false),
                    AccountMeta::new(escrow_k, false),
                    AccountMeta::new(funder, false),
                    AccountMeta::new(source, false),
                ],
            };
            if !r.try_send(
                &[&keeper],
                &[ix],
                &format!("SettleReservation seq {}", res.seq),
            ) {
                let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
                r.log.push(format!("SettleReservation tail: {tail:?}"));
            }
        } else {
            r.log.push("no NOT_APPLIED reservation".into());
        }
    } else {
        let ix = dissolve_ix(&ctx, program, host0, dest, w0);
        if r.try_send(&[&wallet0], &[ix], "Dissolve") {
            dissolved = Some(bell_now(&r));
        } else {
            let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
            r.log.push(format!("Dissolve tail: {tail:?}"));
        }
    }
    if let Some(pend) = dissolved {
        for _ in 0..10 {
            if resolved_next_of(&r, dest_coord) > pend {
                break;
            }
            rwc_once(&mut r);
        }
        let rt =
            ResidentDraft::return_home(&ctx, host0, dest, keeper.pubkey()).expect("a Return draft");
        let ix = Instruction {
            program_id: program,
            accounts: rt
                .roles()
                .iter()
                .map(|ro| meta(ro.address, ro.signer, ro.writable))
                .collect(),
            data: dx::encode(dx::Kind::Return, &rt.proposed_bytes()).unwrap(),
        };
        if !r.try_send(&[&keeper], &[ix], "Return") {
            let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
            r.log.push(format!("Return tail: {tail:?}"));
        }
    }
    // The Season's end: EndSeason once its end bell began, the closes
    // after the 72 h grace.
    let sd = r.data(&a.season).unwrap();
    let (_, _, _, genesis_ts) = clock_of(&sd);
    let end_bell = u32::from_le_bytes(sd[S::END_BELL..S::END_BELL + 4].try_into().unwrap());
    let end = genesis_ts + 600 * end_bell as i64;
    r.advance_to(end + 1);
    if r.try_send(
        &[&keeper],
        &[ix::end_season(&a, keeper.pubkey())],
        "EndSeason",
    ) {
        r.advance_to(end + frontier_abi::presets::END_GRACE_SECS + 1);
        let escrow_k = adr(capture_escrow_address(&ctx, &m0.citizen));
        if let Some(e) = r
            .data(&escrow_k)
            .and_then(|d| WideCaptureEscrow::read(&d, SEASON_ID, world, m0.citizen).ok())
        {
            let mut acc = vec![
                AccountMeta::new_readonly(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(m0.citizen), false),
                AccountMeta::new(escrow_k, false),
                AccountMeta::new(adr(e.rent_payer()), false),
            ];
            if e.escrow() != 0 {
                acc.push(AccountMeta::new(adr(e.funder()), false));
            }
            let ix = Instruction {
                program_id: program,
                accounts: acc,
                data: dx::encode(
                    dx::Kind::CloseCaptureEscrow,
                    &wix::CloseCaptureEscrow.to_bytes(),
                )
                .unwrap(),
            };
            if sc == Sc::Closes {
                r.refused(
                    &[&keeper],
                    &[raw_of(&ix)],
                    "raw CloseCaptureEscrow (CONQUEST_LIFECYCLE_ENABLED)",
                    NOT_IMPLEMENTED,
                );
            }
            if !r.try_send(&[&keeper], &[ix], "CloseCaptureEscrow") {
                let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
                r.log.push(format!("CloseCaptureEscrow tail: {tail:?}"));
            }
        }
        if let Some(t) = r
            .data(&conquest_k)
            .and_then(|d| WideConquest::read(&d, SEASON_ID, dest).ok())
        {
            let ix = Instruction {
                program_id: program,
                data: dx::encode(
                    dx::Kind::CloseConquest,
                    &wix::CloseConquest {
                        p: dest_coord.p(),
                        q: dest_coord.q(),
                    }
                    .to_bytes(),
                )
                .unwrap(),
                accounts: vec![
                    AccountMeta::new_readonly(keeper.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(conquest_k, false),
                    AccountMeta::new(adr(t.rent_payer()), false),
                ],
            };
            if sc == Sc::Closes {
                r.refused(
                    &[&keeper],
                    &[raw_of(&ix)],
                    "raw CloseConquest (CONQUEST_LIFECYCLE_ENABLED)",
                    NOT_IMPLEMENTED,
                );
            }
            if !r.try_send(&[&keeper], &[ix], "CloseConquest") {
                let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
                r.log.push(format!("CloseConquest tail: {tail:?}"));
            }
        }
        if sc == Sc::Closes {
            // verifier-coverage-2: the expedition's own season-end leftovers,
            // closed by the native WideClose: its ArrivalDay (what 3) and the
            // arrival bell's ClashInputs (what 4), each whole to its rent_to.
            let day_k = adr(wa::arrival_day_address(&ctx, dest, wa::day_of(arrive)));
            let day = wa::WideArrivalDay::read(&r.data(&day_k).expect("the ArrivalDay"))
                .expect("a wide ArrivalDay");
            r.send(
                &[&keeper],
                &[wide_ix(
                    &a,
                    vec![
                        AccountMeta::new_readonly(keeper.pubkey(), true),
                        AccountMeta::new_readonly(a.season, false),
                        AccountMeta::new_readonly(dest_key, false),
                        AccountMeta::new(day_k, false),
                        AccountMeta::new(adr(day.rent_to), false),
                    ],
                    wix::Close {
                        what: wix::CLOSE_WHAT_DAY,
                    }
                    .to_bytes()
                    .to_vec(),
                )],
                "WideClose(3) of the expedition's ArrivalDay",
            );
            let ih = WideClashInputsHdr::read(&r.data(&inputs_k).expect("the ClashInputs"))
                .expect("a wide ClashInputs");
            r.send(
                &[&keeper],
                &[wide_ix(
                    &a,
                    vec![
                        AccountMeta::new_readonly(keeper.pubkey(), true),
                        AccountMeta::new_readonly(a.season, false),
                        AccountMeta::new_readonly(dest_key, false),
                        AccountMeta::new(inputs_k, false),
                        AccountMeta::new(adr(ih.rent_to), false),
                    ],
                    wix::Close {
                        what: wix::CLOSE_WHAT_INPUTS,
                    }
                    .to_bytes()
                    .to_vec(),
                )],
                "WideClose(4) of the arrival bell's ClashInputs",
            );
        }
    } else {
        let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
        r.log.push(format!("EndSeason tail: {tail:?}"));
    }

    finish(&r, sc, program, so_hash, &so, &upgrade);
}

/// **Declared patch** (verifier-coverage, `Sc::Forfeit` / `Sc::Failure`):
/// the canonical arrival slot made absent. No real transaction leaves a
/// ClashInputs row whose slot is gone (the expedition slot's closer,
/// `expedition_close::close_slot`, has no non-test caller; the native
/// WideClose refuses a v2 slot; SettleMember closes it but marks the row
/// settled), and the program's own tests of kinds 8/9 patch it the same way.
fn absent_slot(r: &mut Rec, k: Address) {
    r.c.set_account(
        k,
        Account {
            lamports: 0,
            data: vec![],
            owner: Address::default(),
            executable: false,
        },
    )
    .expect("patch");
    let at = r.feed_len();
    r.declared.push(Declared {
        at,
        key: k.to_bytes(),
        account: None,
        what: "the canonical arrival slot made absent (no real path)".into(),
    });
    r.log
        .push("PATCH (set_account, declared): the arrival slot made absent".into());
}

/// The player's Dissolve (dispatch kind 4) of the original host `host`
/// standing in `dest` (`fclient::wide_resident_draft`).
fn dissolve_ix(
    ctx: &AddrCtx,
    program: Address,
    host: frontier_abi::world_index::WideHostRef,
    dest: ProvinceKey,
    wallet: Address,
) -> Instruction {
    let d = fclient::wide_resident_draft::Draft::for_wallet(ctx, host, dest, wallet, wallet)
        .expect("a Dissolve draft");
    Instruction {
        program_id: program,
        accounts: d
            .roles()
            .iter()
            .map(|ro| meta(ro.address, ro.signer, ro.writable))
            .collect(),
        data: dx::encode(dx::Kind::Dissolve, &d.proposed_bytes()).unwrap(),
    }
}

/// verifier-coverage (`Sc::WideHost`): the closed wide host lifecycle of
/// `m` in the first opened wide province, every step a real transaction
/// but the declared reserve (as `playable_wide_march.rs`'s patch 4) and the
/// staged bells (THE anchor and SeedCache, declared: no live drand).
fn wide_host(
    r: &mut Rec,
    m: &Member,
    opened: &[WideCoord],
    payer: &Keypair,
    keeper: &Keypair,
    raw: bool,
) {
    use frontier_abi::world_index::{key::WideHostRef, ticket as wt};
    let a = r.a.clone();
    let c = ctx_of(&a);
    let world = world_of(&a);
    let p0 = opened[0];
    let pkey = ProvinceKey::new(world, p0);
    let prov_k = adr(wl::province_address(&c, p0));
    let roster_k = adr(wro::roster_address(&c, pkey));
    let reg0 = WideProvince::read(&r.data(&prov_k).unwrap())
        .unwrap()
        .region;
    let bell_now = |r: &Rec| -> u32 {
        let sd = r.data(&r.a.season).unwrap();
        let (_, _, _, g) = clock_of(&sd);
        ((r.c.unix_timestamp() - g) / 600) as u32
    };
    let w = m.wallet.pubkey();
    let player = |extra: Vec<AccountMeta>| -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new_readonly(w, true),
            AccountMeta::new(w, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(m.citizen), false),
        ];
        v.extend(extra);
        v
    };
    // 1. The claim (slot 2), its fresh settle, the finality.
    let pd = r.data(&prov_k).unwrap();
    let site = (0..pd[PV::SITE_COUNT])
        .find(|&s| {
            let o = PV::site(s as usize);
            let ro = frontier_abi::v2::layout::province::province::record(s as usize);
            pd[o + SM::STATE] == SM::STATE_FREE && pd[ro..ro + 32].iter().all(|b| *b == 0)
        })
        .expect("a free site");
    let tile = pd[PV::SITES + site as usize];
    let hk = adr(wh::holding_address(&c, p0, site));
    let anchor = adr(c.holding(RIM.0, RIM.1, m.rim_site));
    let anchor_p = adr(c.province(RIM.0, RIM.1));
    let b0 = bell_now(r);
    r.send(
        &[&m.wallet],
        &[wide_ix(
            &a,
            player(vec![
                AccountMeta::new_readonly(a.frontier(), false),
                AccountMeta::new(prov_k, false),
                AccountMeta::new(adr(wt::ticket_address(&c, &m.citizen)), false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ]),
            wix::ClaimSite {
                p: p0.p(),
                q: p0.q(),
                site,
                slot: 2,
            }
            .to_bytes()
            .to_vec(),
        )],
        &format!("WideClaimSite ({p0:?}, site {site}) slot 2"),
    );
    let final0 = stage_seed(r, b0, reg0, seed_of(b0));
    r.send(
        &[payer],
        &[wide_ix(
            &a,
            vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(m.citizen), false),
                AccountMeta::new(adr(wt::ticket_address(&c, &m.citizen)), false),
                AccountMeta::new(hk, false),
                AccountMeta::new(prov_k, false),
                AccountMeta::new(a.join_shard(m.faction, m.shard), false),
                AccountMeta::new_readonly(adr(c.seed_cache(b0, reg0, 0)), false),
                AccountMeta::new_readonly(adr(c.bell_anchor(b0, reg0)), false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::SettleTicket { k: 0 }.to_bytes().to_vec(),
        )],
        "WideSettleTicket (fresh)",
    );
    r.advance_to(final0.max(r.c.unix_timestamp()) + 5);
    r.send(
        &[payer],
        &[wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(hk, false),
                AccountMeta::new_readonly(prov_k, false),
            ],
            wix::Finalize.to_bytes().to_vec(),
        )],
        "WideFinalize",
    );
    let now_b = bell_now(r);
    resolve_through(r, payer, p0, reg0, now_b);
    // 2. Declared: the holding's Spearman reserve.
    const TROOPS: u32 = 3_000;
    r.edit(
        hk.to_bytes(),
        &format!("the wide holding: {TROOPS} Spearmen in reserve"),
        |d| {
            let ro = H::reserve(0);
            d[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
        },
    );
    let muster = |r: &mut Rec, troops: u32, what: &str| -> WideHostRef {
        let hd = r.data(&hk).unwrap();
        let seq = u32::from_le_bytes(hd[H::HOST_SEQ..H::HOST_SEQ + 4].try_into().unwrap());
        let host = WideHostRef::new(pkey, site, hd[H::GEN], seq).unwrap();
        r.send(
            &[&m.wallet],
            &[wide_ix(
                &a,
                player(vec![
                    AccountMeta::new(hk, false),
                    AccountMeta::new(prov_k, false),
                    AccountMeta::new(roster_k, false),
                    AccountMeta::new_readonly(fclient::addr::system_program(), false),
                ]),
                wix::Muster {
                    unit: 0,
                    troops,
                    tile,
                }
                .to_bytes()
                .to_vec(),
            )],
            what,
        );
        host
    };
    let transits = |v: &mut Vec<AccountMeta>| {
        for s in 0..4u8 {
            v.push(AccountMeta::new_readonly(
                adr(frontier_abi::world_index::march::transit_address(
                    &c,
                    &hk.to_bytes(),
                    s,
                )),
                false,
            ));
        }
    };
    // 3. The muster, its bell resolved, WideDissolve, the leave bell, WideReturn.
    // (the standing and the holding's province are one account here: the
    // program's test `dissolve_at` names it twice the same way)
    let dissolve = |r: &mut Rec, host: WideHostRef, what: &str| {
        let mut acc = player(vec![
            AccountMeta::new(hk, false),
            AccountMeta::new(prov_k, false),
            AccountMeta::new_readonly(roster_k, false),
            AccountMeta::new_readonly(prov_k, false),
        ]);
        transits(&mut acc);
        let ix = wide_ix(
            &a,
            acc,
            wix::Dissolve {
                host: host.to_bytes(),
            }
            .to_bytes()
            .to_vec(),
        );
        if !r.try_send(&[&m.wallet], &[ix], what) {
            let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
            r.log.push(format!("{what} tail: {tail:?}"));
        }
        let leave = bell_now(r);
        resolve_through(r, payer, p0, reg0, leave + 1);
    };
    let host = muster(
        r,
        TROOPS,
        &format!("WideMuster {TROOPS} Spearmen onto tile {tile}"),
    );
    let b = bell_now(r);
    resolve_through(r, payer, p0, reg0, b + 1);
    if raw {
        // verifier-coverage-2 (`Sc::WideRaw`): the raw WideDepart of this
        // standing wide host (state 1, its province resolved, a syntactically
        // valid seal, the tip floor) passes every check and is refused by the
        // debit gate (DEPART_DEBIT_ENABLED, off in the devnet-playable build)
        // with NotImplemented before its first effect.
        let sd = r.data(&a.season).unwrap();
        let season = fclient::decode::Season::decode(&sd).expect("the Season");
        let tip = fclient::fees::min_tip_lamports(
            season.min_reveal_priority_milli,
            season.reveal_cu_limit,
            season.reveal_loaded_limit,
        );
        let mut seal = [0u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN];
        seal[0] = 0x80;
        let mut acc = player(vec![
            AccountMeta::new(hk, false),
            AccountMeta::new(prov_k, false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
            AccountMeta::new_readonly(prov_k, false),
        ]);
        for s in 0..4u8 {
            let t = adr(frontier_abi::world_index::march::transit_address(
                &c,
                &hk.to_bytes(),
                s,
            ));
            acc.push(if s == 0 {
                AccountMeta::new(t, false)
            } else {
                AccountMeta::new_readonly(t, false)
            });
        }
        acc.push(AccountMeta::new_readonly(roster_k, false));
        let now_b = bell_now(r);
        let ix = wide_ix(
            &a,
            acc,
            wix::Depart {
                host: host.to_bytes(),
                transit_slot: 0,
                arrive_bell: now_b + 4,
                tip,
                commit: [7; 32],
                seal,
            }
            .to_bytes()
            .to_vec(),
        );
        if r.local {
            // the local land build: the same transaction departs
            r.send(
                &[&m.wallet],
                &[ix],
                "raw WideDepart of a standing wide host (local land .so: the gate is open)",
            );
            // (the host is now in transit: the rest of the lifecycle is not
            // this run's; the archive ends with the WideDepart)
            return;
        } else {
            r.refused(
                &[&m.wallet],
                &[ix],
                "raw WideDepart of a standing wide host (DEPART_DEBIT_ENABLED)",
                NOT_IMPLEMENTED,
            );
        }
    }
    dissolve(r, host, "WideDissolve");
    let ret = |r: &mut Rec, what: &str| {
        let mut acc = vec![
            AccountMeta::new(keeper.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(prov_k, false),
            AccountMeta::new(roster_k, false),
            AccountMeta::new(hk, false),
        ];
        transits(&mut acc);
        if !r.try_send(
            &[keeper],
            &[wide_ix(&a, acc, wix::Return.to_bytes().to_vec())],
            what,
        ) {
            let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
            r.log.push(format!("{what} tail: {tail:?}"));
        }
    };
    ret(r, "WideReturn");
    // 4. A second host left departed; the Season's end; the holding closed
    // (the host is then stranded), WideDisbandStranded, WideCloseRoster.
    // (dissolved and its leave bell resolved, never returned: DEPARTED, so
    // DisbandStranded frees it at once once its holding is gone; a ROSTER
    // entry would need the province resolved through the end bell)
    let host2 = muster(r, 1_000, "WideMuster 1000 Spearmen (never returned)");
    let b = bell_now(r);
    resolve_through(r, payer, p0, reg0, b + 1);
    dissolve(r, host2, "WideDissolve of the second host");
    // verifier-coverage-2 (`Sc::WideRaw`): the raw WideGather is NOT gated:
    // over a bell with no ArrivalDay bit it creates a no-arrival ClashInputs
    // (every position scanned) and succeeds; the bell's WideResolve then
    // reads it, and the season-end WideClose(4) closes it.
    let mut raw_inputs = None;
    if raw {
        let gb = resolved_next(r, p0);
        if r.c.account(&adr(c.bell_anchor(gb, reg0))).is_none() {
            stage_seed(r, gb, reg0, seed_of(gb));
        }
        let close = window_close(r, gb);
        if r.c.unix_timestamp() < close + 1 {
            r.advance_to(close + 1);
        }
        let inputs = adr(wa::clash_inputs_address(&c, pkey, gb));
        let mut acc = vec![
            AccountMeta::new(keeper.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new_readonly(prov_k, false),
            AccountMeta::new_readonly(a.anchor(gb, reg0), false),
            AccountMeta::new(inputs, false),
            AccountMeta::new_readonly(
                adr(wa::arrival_day_address(&c, pkey, wa::day_of(gb))),
                false,
            ),
            AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ];
        let positions = 4 * fclient::abi::FACTIONS;
        for k in 0..positions {
            acc.push(AccountMeta::new_readonly(
                adr(wa::arrival_slot_address(&c, pkey, gb, k / 4, k % 4)),
                false,
            ));
            acc.push(AccountMeta::new_readonly(
                fclient::addr::system_program(),
                false,
            ));
        }
        r.send(
            &[keeper],
            &[wide_ix(
                &a,
                acc,
                wix::Gather {
                    bell: gb,
                    start: 0,
                    n: positions,
                }
                .to_bytes()
                .to_vec(),
            )],
            &format!("raw WideGather bell {gb} (no arrivals)"),
        );
        resolve_through(r, payer, p0, reg0, gb + 1);
        raw_inputs = Some(inputs);
    }
    end_season(r, keeper);
    let rent_payer: [u8; 32] = r.data(&hk).unwrap()[H::RENT_PAYER..H::RENT_PAYER + 32]
        .try_into()
        .unwrap();
    if !r.try_send(
        &[keeper],
        &[wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(hk, false),
                AccountMeta::new(adr(rent_payer), false),
                AccountMeta::new(a.defence_pool(), false),
            ],
            wix::Close {
                what: wix::CLOSE_WHAT_HOLDING,
            }
            .to_bytes()
            .to_vec(),
        )],
        "WideClose(holding)",
    ) {
        let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
        r.log.push(format!("WideClose(holding) tail: {tail:?}"));
    }
    let pd = r.data(&prov_k).unwrap();
    let entry = (0..pd[PV::N_ENTRIES] as usize).find(|&i| {
        frontier_abi::entry::read_entry(&pd, i).is_ok_and(|e| {
            e.faction == m.faction && e.state != frontier_abi::layout::province::entry::STATE_FREE
        })
    });
    r.log
        .push(format!("the standing entry to disband: {entry:?}"));
    if let Some(entry) = entry {
        let mut acc = vec![
            AccountMeta::new_readonly(keeper.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(prov_k, false),
            AccountMeta::new(roster_k, false),
            AccountMeta::new_readonly(hk, false),
        ];
        transits(&mut acc);
        if !r.try_send(
            &[keeper],
            &[wide_ix(
                &a,
                acc,
                wix::DisbandStranded { entry: entry as u8 }
                    .to_bytes()
                    .to_vec(),
            )],
            "WideDisbandStranded",
        ) {
            let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
            r.log.push(format!("WideDisbandStranded tail: {tail:?}"));
        }
    }
    let rd = r.data(&roster_k).expect("the roster");
    let rent_to = wro::WideRoster::read(&rd).map(|x| x.rent_to);
    r.log.push(format!("the roster's rent_to: {rent_to:?}"));
    let rent_to = rent_to.map(adr).unwrap_or(payer.pubkey());
    if !r.try_send(
        &[keeper],
        &[wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(keeper.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(roster_k, false),
                AccountMeta::new(rent_to, false),
                AccountMeta::new_readonly(prov_k, false),
            ],
            wix::CloseRoster.to_bytes().to_vec(),
        )],
        "WideCloseRoster",
    ) {
        let tail: Vec<_> = r.last_logs.iter().rev().take(6).rev().cloned().collect();
        r.log.push(format!("WideCloseRoster tail: {tail:?}"));
    }
    if let Some(inputs) = raw_inputs {
        let ih = WideClashInputsHdr::read(&r.data(&inputs).expect("the raw gather's ClashInputs"))
            .expect("a wide ClashInputs");
        r.send(
            &[keeper],
            &[wide_ix(
                &a,
                vec![
                    AccountMeta::new_readonly(keeper.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new_readonly(prov_k, false),
                    AccountMeta::new(inputs, false),
                    AccountMeta::new(adr(ih.rent_to), false),
                ],
                wix::Close {
                    what: wix::CLOSE_WHAT_INPUTS,
                }
                .to_bytes()
                .to_vec(),
            )],
            "WideClose(4) of the raw gather's ClashInputs",
        );
    }
}

/// EndSeason once the Season's end bell began, then the 72 h grace.
fn end_season(r: &mut Rec, keeper: &Keypair) {
    let sd = r.data(&r.a.season).unwrap();
    let (_, _, _, genesis_ts) = clock_of(&sd);
    let end_bell = u32::from_le_bytes(sd[S::END_BELL..S::END_BELL + 4].try_into().unwrap());
    let end = genesis_ts + 600 * end_bell as i64;
    r.advance_to(end + 1);
    let a = r.a.clone();
    r.send(
        &[keeper],
        &[ix::end_season(&a, keeper.pubkey())],
        "EndSeason",
    );
    r.advance_to(end + frontier_abi::presets::END_GRACE_SECS + 1);
}

/// The archive of the whole season from AnnounceSeason on (the UNFILTERED
/// feed, the declared patches with it, the chain witness), judged once for
/// the log and saved under `PLAYABLE_EXPEDITION_DUMP` as `sc`'s fixture.
fn finish(r: &Rec, sc: Sc, program: Address, so_hash: [u8; 32], so: &[u8], upgrade: &Keypair) {
    // The archive: the whole season from AnnounceSeason on, the
    // UNFILTERED feed, the declared patches with it.
    let (txs, mut finals) = r.archive(0, &program);
    if sc != Sc::Main {
        // verifier-coverage: the final of every declared account too (the
        // staged bells' THE anchors and SeedCaches no transaction writes),
        // as a read of every program account shows it; VG asks for it.
        for d in &r.declared {
            finals
                .entry(d.key)
                .or_insert_with(|| r.c.account(&adr(d.key)).filter(|a| a.lamports > 0));
        }
    }
    let mut whole = input_of(
        program,
        so_hash,
        txs,
        finals,
        r.c.slot(),
        format!(
            "verify/tests/playable_expedition.rs record(Sc::{sc:?}): the devnet-playable .so built from origin/main c889f6cf (sha256 {MAIN_SHA256}) in localnet::Chain (LiteSVM, in process); a real placement-2 season by its own instructions, the declared wide land patch (RingSeed(128), Frontier wedge counters) and the real ring-129 opening, the declared rim-homes patch (as playable_wide_march.rs), the declared host patch (player 0's {STRONG_TROOPS} milli-troop host on its rim home, the rim's resolved_next), THE anchor and SeedCache of every resolved bell declared with a literal seed (no live drand, O-M1-12), the real expedition wrapper (ExpeditionDepart, SettleOrigin, ExpeditionReveal, ExpeditionGather, SettleMember) to the Free City's tile and the Free City conquest through the wrapper (DeclareSiege, ResolveWithConquest, …); the UNFILTERED feed; every patch is in `declared`; steps: {}",
            r.log.join("; ")
        ),
        sc.fixture().trim_end_matches(".json.gz"),
    );
    whole.declared = r.declared.clone();
    // What getTransaction serves beside each transaction (VG's input).
    whole.chain = verify_core::input::ChainWitness {
        balances: r
            .c
            .feed(0, usize::MAX, Some(&program))
            .into_iter()
            .map(|l| {
                (
                    l.signature.to_string(),
                    verify_core::input::Balances {
                        pre: l.pre_balances.clone(),
                        post: l.post_balances.clone(),
                    },
                )
            })
            .collect(),
        upgrade_authority: Some(upgrade.pubkey()),
        cross: None,
        rent: None,
        lookup_tables: None,
    };
    for l in &r.log {
        println!("STEP {l}");
    }
    let mut judged = whole.clone();
    judged.program_so = Some(std::sync::Arc::new(so.to_vec()));
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
        let name = if r.local {
            "playable-local-wideraw.json.gz"
        } else {
            sc.fixture()
        };
        whole.save(&d.join(name)).expect("save");
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
    // (the siege's resolves between the declaration and the capture; the
    //  ones after it resolve the leave bell for Dissolve → Return)
    let capture = one(&inp, SettleCapture);
    assert!(of_kind(&inp, ResolveWithConquest)
        .iter()
        .all(|&t| t > at[5]));
    assert!(
        of_kind(&inp, ResolveWithConquest)
            .iter()
            .filter(|&&t| t < capture)
            .count()
            >= 36
    );
    // verifier-archive-next: after the capture, the host leaves and goes
    // home, the Season ends and the Free City's accounts close
    let after = [Dissolve, Return, CloseCaptureEscrow, CloseConquest];
    let at2: Vec<usize> = after.iter().map(|k| one(&inp, *k)).collect();
    assert!(
        capture < at2[0] && at2.windows(2).all(|w| w[0] < w[1]),
        "{at2:?}"
    );
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
            d.contains("only declares")
                || d.contains("bell anchor")
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
        // verifier-archive-next
        Dissolve,
        Return,
        CloseCaptureEscrow,
        CloseConquest,
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
    let capture = one(&inp, dx::Kind::SettleCapture);
    let rs = of_kind(&inp, dx::Kind::ResolveWithConquest);
    let gone = *rs.iter().rfind(|&&t| t < capture).unwrap();
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

// ---- verify-pr89: the provenance of the states VX starts from

/// The Depart's declared patches as one final state per key (each key's
/// patches removed from `declared`), for laundering into an archived post.
fn take_depart_patches(inp: &mut Input, d: usize) -> Vec<Declared> {
    let keys: Vec<[u8; 32]> = fclient::tx::from_wire(&inp.txs[d].tx)
        .unwrap()
        .message
        .account_keys
        .iter()
        .map(|k| k.to_bytes())
        .collect();
    let mut out = vec![];
    for k in &keys {
        if let Some(p) = inp.declared.iter().rposition(|x| x.key == *k && x.at <= d) {
            out.push(inp.declared.remove(p));
            inp.declared.retain(|x| !(x.key == *k && x.at <= d));
        }
    }
    assert!(!out.is_empty());
    out
}

fn launder(inp: &mut Input, host: usize, p: &Declared) {
    let k = Address::new_from_array(p.key);
    inp.txs[host].post.retain(|(x, _)| *x != k);
    inp.txs[host].post.push((k, p.account.clone()));
}

#[test]
fn a_state_laundered_into_a_transaction_that_does_not_write_it_fails() {
    // the recorder's host and rim-home patches shown as the post-states of
    // the transaction before the Depart, which does not name them: without
    // the provenance rule VX re-executed the Depart "exactly" from them
    let mut inp = recorded();
    let d = one(&inp, dx::Kind::Depart);
    let host = d - 1;
    let names = fclient::tx::from_wire(&inp.txs[host].tx)
        .unwrap()
        .message
        .account_keys;
    let patches = take_depart_patches(&mut inp, d);
    assert!(patches
        .iter()
        .any(|p| !names.contains(&Address::new_from_array(p.key))));
    for p in &patches {
        launder(&mut inp, host, p);
    }
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(
        vx_at(&rep, d).iter().any(|f| f.severity == Severity::Fail
            && f.detail.contains("does not hold that account writable")),
        "{:#?}",
        vx_at(&rep, d)
    );
    // and every wrapper transaction that builds on it
    let o = one(&inp, dx::Kind::SettleOrigin);
    assert!(fails_vx(&rep, o, "ReExecMismatch"), "{:#?}", vx_at(&rep, o));
}

#[test]
fn a_state_forged_into_an_earlier_writers_post_fails() {
    // only the patched rim province, shown as the post-state of the
    // OpenProvince before the Depart (which does write it): the pinned
    // program does not reproduce that post-state
    let mut inp = recorded();
    let d = one(&inp, dx::Kind::Depart);
    let host = d - 1;
    let m = fclient::tx::from_wire(&inp.txs[host].tx).unwrap().message;
    let patches = take_depart_patches(&mut inp, d);
    let (written, rest): (Vec<Declared>, Vec<Declared>) = patches.into_iter().partition(|p| {
        m.account_keys
            .iter()
            .position(|x| x.to_bytes() == p.key)
            .is_some_and(|i| tx::is_writable_index(&m, i))
    });
    assert_eq!(written.len(), 1, "the province");
    launder(&mut inp, host, &written[0]);
    // the others stay declared, from before the Depart
    inp.declared.extend(rest);
    inp.declared.sort_by_key(|x| x.at);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(
        vx_at(&rep, d)
            .iter()
            .any(|f| f.severity == Severity::Fail && f.detail.contains("does not reproduce")),
        "{:#?}",
        vx_at(&rep, d)
    );
}

// ------------------------------------------- verifier-archive-next: the new kinds

/// A program-owned post-state of transaction `t` with data.
fn program_post(inp: &Input, t: usize) -> Address {
    inp.txs[t]
        .post
        .iter()
        .find(|(_, a)| {
            a.as_ref()
                .is_some_and(|a| a.owner == inp.cfg.program && !a.data.is_empty())
        })
        .map(|(k, _)| *k)
        .expect("a program post-state")
}

#[test]
fn a_forged_post_state_at_each_new_kind_fails() {
    use dx::Kind::*;
    for k in [Dissolve, Return] {
        let mut inp = recorded();
        let t = one(&inp, k);
        let key = program_post(&inp, t);
        edit_post(&mut inp, t, &key, |a| {
            let n = a.data.len() - 1;
            a.data[n] ^= 1;
        });
        let rep = verify_core::verify(&inp);
        assert_eq!(rep.verdict, Verdict::Fail, "{k:?}: {:#?}", show(&rep));
        assert!(
            fails_vx(&rep, t, "ReExecMismatch"),
            "{k:?}: {:#?}",
            vx_at(&rep, t)
        );
    }
}

#[test]
fn a_close_the_archive_says_left_an_account_open_fails() {
    // CloseCaptureEscrow / CloseConquest close their account: an archive
    // that keeps it (the re-run closes it) fails.
    use dx::Kind::*;
    for k in [CloseCaptureEscrow, CloseConquest] {
        let mut inp = recorded();
        let t = one(&inp, k);
        let prior = inp.txs[..t]
            .iter()
            .rev()
            .find_map(|x| {
                x.post
                    .iter()
                    .find(|(key, a)| {
                        inp.txs[t]
                            .post
                            .iter()
                            .any(|(k2, b)| k2 == key && b.is_none())
                            && a.as_ref().is_some_and(|a| a.owner == inp.cfg.program)
                    })
                    .cloned()
            })
            .expect("the account it closes, as an earlier post showed it");
        let slot = inp.txs[t]
            .post
            .iter_mut()
            .find(|(key, _)| *key == prior.0)
            .unwrap();
        slot.1 = prior.1.clone();
        let rep = verify_core::verify(&inp);
        assert_eq!(rep.verdict, Verdict::Fail, "{k:?}: {:#?}", show(&rep));
        assert!(
            fails_vx(&rep, t, "ReExecMismatch"),
            "{k:?}: {:#?}",
            vx_at(&rep, t)
        );
    }
}

#[test]
fn a_return_before_its_leave_bell_resolved_fails() {
    // Without the ResolveWithConquest of the leave bell, the program refuses
    // the Return (TooEarly) from the states the archive shows.
    use dx::Kind::*;
    let mut inp = recorded();
    let (d, rt) = (one(&inp, Dissolve), one(&inp, Return));
    let gone = *of_kind(&inp, ResolveWithConquest)
        .iter()
        .find(|&&t| t > d && t < rt)
        .expect("the leave bell's resolve");
    inp.txs.remove(gone);
    for x in &mut inp.declared {
        if x.at > gone {
            x.at -= 1;
        }
    }
    let t = one(&inp, Return);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(fails_vx(&rep, t, "ReExecRefused"), "{:#?}", vx_at(&rep, t));
}

// ------------------------------------------- verifier-archive-next: VG

#[test]
fn without_post_states_the_expedition_is_re_executed_from_genesis_with_the_same_findings() {
    // The recording as a public RPC serves it (no post-states), with the
    // chain's balances: VG re-derives every post-state, and the season's
    // judgement is the same: no FAIL, and only the recorder's declared
    // patches keep it from a PASS.
    let rec = recorded();
    assert_eq!(rec.chain.balances.len(), rec.txs.len());
    let mut inp = rec.clone();
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    let rep = verify_core::verify(&inp);
    assert!(
        rep.checks_run.contains(&"VG:genesis-replay"),
        "{:?}",
        rep.checks_run
    );
    assert_eq!(rep.verdict, Verdict::Unverifiable, "{:#?}", show(&rep));
    for f in &rep.findings {
        assert_ne!(f.severity, Severity::Fail, "{:#?}", show(&rep));
    }
    // The derived program post-states are the recorded ones.
    let d = verify_core::genesis::derive(&inp);
    assert!(d.findings.iter().all(|f| !f.fail()), "{:?}", d.findings);
    let derived = d.input.unwrap();
    let mut n = 0;
    for (i, (a, b)) in rec.txs.iter().zip(derived.txs.iter()).enumerate() {
        if a.err.is_some() {
            continue;
        }
        for (k, acc) in &a.post {
            if acc.as_ref().is_some_and(|x| x.owner == rec.cfg.program) {
                let got = b.post.iter().find(|(x, _)| x == k).map(|(_, s)| s);
                assert_eq!(got, Some(acc), "tx#{i} {k}");
                n += 1;
            }
        }
    }
    assert!(n > 200, "{n}");
}

#[test]
fn without_post_states_a_forged_gather_log_fails() {
    let mut inp = recorded();
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    let t = one(&inp, dx::Kind::Gather);
    let l = inp.txs[t]
        .logs
        .iter_mut()
        .find(|l| l.starts_with("Program data: "))
        .unwrap();
    let n = l.len() - 6;
    let c = if l.as_bytes()[n] == b'A' { "B" } else { "A" };
    l.replace_range(n..n + 1, c);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(rep
        .findings
        .iter()
        .any(|f| f.fail() && f.check == "VG" && f.entity == format!("tx#{t}")));
}

// ------------------------------------- verifier-coverage: the remaining kinds

/// A coverage recording (`record_playable_coverage`), with the pinned
/// program given to VX.
fn cov(sc: Sc) -> Input {
    let mut inp = common::fixture(sc.fixture());
    inp.program_so = Some(so());
    inp
}

/// The wide-native command of transaction `t`'s first program instruction
/// (WideDissolve, WideReturn, …), if it is one.
fn native_at(inp: &Input, t: usize) -> Option<&'static str> {
    let (data, _) = prog_ix(inp, t)?;
    wix::WideCommand::decode(&data).ok().map(|c| c.name())
}

fn of_native(inp: &Input, name: &str) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_none() && native_at(inp, t) == Some(name))
        .collect()
}

/// What a coverage recording's declared patches explain: the main
/// recording's, and V7's view of a patched rim home of player 1 (the
/// WideHost claim's anchor), which no archived transaction wrote.
fn cov_explained(f: &Finding) -> bool {
    explained(f) || (f.check == "V7" && f.detail.contains("no earlier post-state"))
}

/// The transactions each scenario adds: dispatch kinds, then wide-native
/// commands, each recorded exactly as many times.
/// (dispatch kinds, wide-native commands), each with its count.
type Targets = (Vec<(dx::Kind, usize)>, Vec<(&'static str, usize)>);

fn cov_targets(sc: Sc) -> Targets {
    use dx::Kind::*;
    match sc {
        Sc::Siege => (
            vec![(SettleSiege, 1), (SettleReservation, 1), (DeclareSiege, 2)],
            vec![],
        ),
        Sc::Retained => (vec![(SettleRetainedFailure, 1)], vec![]),
        Sc::Forfeit => (vec![(SettleForfeit, 1)], vec![]),
        Sc::Failure => (vec![(SettleFailure, 1)], vec![]),
        Sc::Terminal => (vec![(CloseTerminal, 1)], vec![]),
        Sc::Camp => (vec![(SettleCamp, 1)], vec![]),
        Sc::WideHost => (
            vec![],
            vec![
                ("WideDissolve", 2),
                ("WideReturn", 1),
                ("WideDisbandStranded", 1),
                ("WideCloseRoster", 1),
            ],
        ),
        Sc::Closes => (vec![], vec![("WideClose", 2)]),
        Sc::WideRaw => (
            vec![],
            vec![
                ("WideDissolve", 2),
                ("WideReturn", 1),
                ("WideDisbandStranded", 1),
                ("WideCloseRoster", 1),
                ("WideGather", 1),
            ],
        ),
        Sc::Main => (vec![], vec![]),
    }
}

fn cov_txs(inp: &Input, sc: Sc) -> Vec<(String, usize)> {
    let (kinds, natives) = cov_targets(sc);
    let mut out = vec![];
    for (k, n) in kinds {
        let v = of_kind(inp, k);
        assert_eq!(v.len(), n, "{sc:?} {k:?}: {v:?}");
        out.extend(v.into_iter().map(|t| (format!("{k:?}"), t)));
    }
    for (name, n) in natives {
        let v = of_native(inp, name);
        assert_eq!(v.len(), n, "{sc:?} {name}: {v:?}");
        out.extend(v.into_iter().map(|t| (name.to_string(), t)));
    }
    out
}

/// Kinds 8 and 9 start from the one declared patch no real path avoids.
fn patched(sc: Sc) -> bool {
    matches!(sc, Sc::Forfeit | Sc::Failure)
}

/// Whether transaction `name` of `sc` starts from a declared state: kinds 8
/// and 9 (above), and (verifier-coverage-2) the raw WideGather, which reads
/// its bell's THE anchor, staged by the recorder (no live drand, O-M1-12;
/// on a real chain PostAnchor writes it).
fn starts_declared(sc: Sc, name: &str) -> bool {
    (patched(sc) && name != "DeclareSiege") || (sc == Sc::WideRaw && name == "WideGather")
}

fn assert_honest(inp: &Input, sc: Sc, how: &str) {
    let rep = verify_core::verify(inp);
    assert_eq!(
        rep.verdict,
        Verdict::Unverifiable,
        "{sc:?} {how}: {:#?}",
        show(&rep)
    );
    for f in &rep.findings {
        assert_ne!(
            f.severity,
            Severity::Fail,
            "{sc:?} {how}: {:#?}",
            show(&rep)
        );
        if f.severity == Severity::Unverifiable {
            assert!(
                cov_explained(f),
                "{sc:?} {how}: an unexplained finding: {f:?}"
            );
        }
    }
    assert!(
        rep.findings.iter().all(|f| f.code != "WideUnmodelled"),
        "{sc:?} {how}: {:#?}",
        show(&rep)
    );
    for (name, t) in cov_txs(inp, sc) {
        let v = vx_at(&rep, t);
        if starts_declared(sc, &name) {
            // re-executed exactly, from a declared state: never PASS
            assert!(
                v.len() == 1
                    && v[0].severity == Severity::Unverifiable
                    && v[0].detail.contains("re-executed exactly")
                    && v[0].detail.contains("only declares"),
                "{sc:?} {how} {name} tx#{t}: {v:?}"
            );
        } else {
            assert!(v.is_empty(), "{sc:?} {how} {name} tx#{t}: {v:?}");
        }
    }
}

#[test]
fn every_remaining_kind_and_wide_native_op_is_recorded_on_the_pinned_program() {
    for sc in Sc::COVERAGE {
        let inp = cov(sc);
        assert_eq!(
            inp.cfg.program_hash.map(hex::encode).as_deref(),
            Some(MAIN_SHA256),
            "{sc:?}"
        );
        assert_eq!(inp.chain.balances.len(), inp.txs.len(), "{sc:?}");
        let found = cov_txs(&inp, sc);
        assert!(!found.is_empty(), "{sc:?}");
        // real transactions only, but the main recording's patches and, for
        // kinds 8 / 9, the arrival slot (and kind 8's fate)
        let extra: Vec<&str> = inp
            .declared
            .iter()
            .map(|d| d.what.as_str())
            .filter(|w| w.contains("arrival slot") || w.contains("fate DESTROYED"))
            .collect();
        match sc {
            Sc::Forfeit => assert_eq!(extra.len(), 1, "{extra:?}"),
            Sc::Failure => assert_eq!(extra.len(), 2, "{extra:?}"),
            _ => assert!(extra.is_empty(), "{sc:?}: {extra:?}"),
        }
    }
}

#[test]
fn each_remaining_kind_re_executes_exactly_with_post_states() {
    for sc in Sc::COVERAGE {
        assert_honest(&cov(sc), sc, "with post-states");
    }
}

#[test]
fn each_remaining_kind_re_executes_exactly_from_genesis_without_post_states() {
    // As a public RPC serves it: VG derives every post-state first.
    for sc in Sc::COVERAGE {
        let rec = cov(sc);
        let mut inp = rec.clone();
        for t in inp.txs.iter_mut() {
            t.post.clear();
        }
        let rep = verify_core::verify(&inp);
        assert!(rep.checks_run.contains(&"VG:genesis-replay"), "{sc:?}");
        assert_honest(&inp, sc, "VG");
        // and VG derives the recorded program states, byte for byte
        let d = verify_core::genesis::derive(&inp);
        assert!(
            d.findings.iter().all(|f| !f.fail()),
            "{sc:?}: {:?}",
            d.findings
        );
        let derived = d.input.unwrap();
        for (i, (a, b)) in rec.txs.iter().zip(derived.txs.iter()).enumerate() {
            if a.err.is_some() {
                continue;
            }
            for (k, acc) in &a.post {
                if acc.as_ref().is_some_and(|x| x.owner == rec.cfg.program) {
                    let got = b.post.iter().find(|(x, _)| x == k).map(|(_, s)| s);
                    assert_eq!(got, Some(acc), "{sc:?} tx#{i} {k}");
                }
            }
        }
    }
}

#[test]
fn without_the_pinned_binary_no_remaining_kind_passes() {
    for sc in Sc::COVERAGE {
        let mut inp = cov(sc);
        inp.program_so = None;
        let rep = verify_core::verify(&inp);
        assert_ne!(rep.verdict, Verdict::Pass, "{sc:?}");
        for (name, t) in cov_txs(&inp, sc) {
            assert!(
                vx_at(&rep, t)
                    .iter()
                    .any(|f| f.severity == Severity::Unverifiable
                        && f.detail.contains("no program binary")),
                "{sc:?} {name} tx#{t}: {:?}",
                vx_at(&rep, t)
            );
        }
    }
}

/// A program post-state of transaction `t` with data (the first one).
fn some_program_post(inp: &Input, t: usize) -> Option<Address> {
    inp.txs[t]
        .post
        .iter()
        .find(|(_, a)| {
            a.as_ref()
                .is_some_and(|a| a.owner == inp.cfg.program && !a.data.is_empty())
        })
        .map(|(k, _)| *k)
}

#[test]
fn a_forged_post_state_at_each_remaining_kind_fails() {
    for sc in Sc::COVERAGE {
        for (name, t) in cov_txs(&cov(sc), sc) {
            let mut inp = cov(sc);
            let Some(key) = some_program_post(&inp, t) else {
                // (a pure close: every program account it writes ends closed)
                let k = inp.txs[t]
                    .post
                    .iter()
                    .find(|(_, a)| a.is_none())
                    .map(|(k, _)| *k)
                    .expect("a closed account");
                let back = inp.txs[..t]
                    .iter()
                    .rev()
                    .find_map(|x| x.post.iter().find(|(y, _)| *y == k).cloned())
                    .expect("its state before");
                let slot = inp.txs[t].post.iter_mut().find(|(y, _)| *y == k).unwrap();
                slot.1 = back.1;
                let rep = verify_core::verify(&inp);
                assert_eq!(
                    rep.verdict,
                    Verdict::Fail,
                    "{sc:?} {name}: {:#?}",
                    show(&rep)
                );
                assert!(
                    fails_vx(&rep, t, "ReExecMismatch"),
                    "{sc:?} {name}: {:?}",
                    vx_at(&rep, t)
                );
                continue;
            };
            edit_post(&mut inp, t, &key, |a| {
                let n = a.data.len() - 1;
                a.data[n] ^= 1;
            });
            let rep = verify_core::verify(&inp);
            assert_eq!(
                rep.verdict,
                Verdict::Fail,
                "{sc:?} {name}: {:#?}",
                show(&rep)
            );
            assert!(
                fails_vx(&rep, t, "ReExecMismatch"),
                "{sc:?} {name} tx#{t}: {:?}",
                vx_at(&rep, t)
            );
        }
    }
}

#[test]
fn without_post_states_a_forged_record_at_each_remaining_kind_fails() {
    let mut forged = 0;
    for sc in Sc::COVERAGE {
        for (name, t) in cov_txs(&cov(sc), sc) {
            let mut inp = cov(sc);
            for x in inp.txs.iter_mut() {
                x.post.clear();
            }
            let Some(l) = inp.txs[t]
                .logs
                .iter_mut()
                .find(|l| l.starts_with("Program data: "))
            else {
                continue;
            };
            let n = l.len() - 6;
            let c = if l.as_bytes()[n] == b'A' { "B" } else { "A" };
            l.replace_range(n..n + 1, c);
            forged += 1;
            let rep = verify_core::verify(&inp);
            assert_eq!(
                rep.verdict,
                Verdict::Fail,
                "{sc:?} {name}: {:#?}",
                show(&rep)
            );
            assert!(
                rep.findings
                    .iter()
                    .any(|f| f.fail() && f.check == "VG" && f.entity == format!("tx#{t}")),
                "{sc:?} {name} tx#{t}: {:#?}",
                show(&rep)
            );
        }
    }
    // every kind and op prints a record (the closes too)
    assert!(forged >= 13, "{forged}");
}

#[test]
fn a_wide_return_before_its_leave_bell_resolved_fails() {
    // WideReturn needs the leave bell's WideResolve (the entry DEPARTED):
    // without it the program finds nothing to return (AlreadyDone).
    let sc = Sc::WideHost;
    let mut inp = cov(sc);
    let d = of_native(&inp, "WideDissolve")[0];
    let rt = one_native(&inp, "WideReturn");
    let gone: Vec<usize> = (d + 1..rt)
        .filter(|&t| inp.txs[t].err.is_none() && native_at(&inp, t) == Some("WideResolve"))
        .collect();
    assert!(!gone.is_empty());
    for &g in gone.iter().rev() {
        inp.txs.remove(g);
        for x in &mut inp.declared {
            if x.at > g {
                x.at -= 1;
            }
        }
    }
    let t = one_native(&inp, "WideReturn");
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(fails_vx(&rep, t, "ReExecRefused"), "{:?}", vx_at(&rep, t));
}

fn one_native(inp: &Input, name: &str) -> usize {
    let v = of_native(inp, name);
    assert_eq!(v.len(), 1, "{name}: {v:?}");
    v[0]
}

#[test]
fn a_settlement_archived_as_failed_that_the_program_runs_fails() {
    // SettleRetainedFailure archived with a program error the pinned program
    // does not raise (it runs the transaction to success): VG FAILs.
    let mut inp = cov(Sc::Retained);
    let t = one(&inp, dx::Kind::SettleRetainedFailure);
    for x in inp.txs.iter_mut() {
        x.post.clear();
    }
    inp.txs[t].err = Some("InstructionError(4, Custom(99))".into());
    inp.txs[t].code = Some(99);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
}

// ------------------------------------------- verify-pr97: independent mutations
//
// The reviewer's own mutations (verify-pr97), one or more per new kind and
// wide-native op: none may PASS; each is asserted to FAIL unless noted.

mod verify_pr97 {
    use super::*;

    fn strip(inp: &mut Input) {
        for x in inp.txs.iter_mut() {
            x.post.clear();
        }
    }

    fn not_pass(inp: &Input, what: &str) -> Report {
        let rep = verify_core::verify(inp);
        assert_ne!(rep.verdict, Verdict::Pass, "{what}");
        rep
    }

    fn fails(inp: &Input, what: &str) -> Report {
        let rep = verify_core::verify(inp);
        assert_eq!(rep.verdict, Verdict::Fail, "{what}: {:#?}", show(&rep));
        rep
    }

    /// The position in tx `t`'s message keys of account `k`.
    fn key_index(inp: &Input, t: usize, k: &Address) -> usize {
        let x = tx::from_wire(&inp.txs[t].tx).unwrap();
        x.message.account_keys.iter().position(|a| a == k).unwrap()
    }

    fn bal_mut(inp: &mut Input, t: usize) -> &mut verify_core::input::Balances {
        let s = inp.txs[t].signature.to_string();
        inp.chain.balances.get_mut(&s).unwrap()
    }

    /// Flip one base64 char inside the first `Program data:` line (the
    /// receipt), keeping post-states (so VX compares the logs).
    fn flip_log(inp: &mut Input, t: usize) {
        let l = inp.txs[t]
            .logs
            .iter_mut()
            .find(|l| l.starts_with("Program data: "))
            .expect("a record");
        let n = l.len() / 2 + 7;
        let c = if l.as_bytes()[n] == b'Q' { "R" } else { "Q" };
        l.replace_range(n..n + 1, c);
    }

    #[test]
    fn m01_settle_siege_receipt_forged_with_post_states_fails() {
        let mut inp = cov(Sc::Siege);
        let t = one(&inp, dx::Kind::SettleSiege);
        flip_log(&mut inp, t);
        let rep = fails(&inp, "M1");
        assert!(
            vx_at(&rep, t).iter().any(|f| f.severity == Severity::Fail),
            "{:?}",
            vx_at(&rep, t)
        );
    }

    #[test]
    fn m02_settle_reservation_omitted_fails() {
        let mut inp = cov(Sc::Siege);
        let t = one(&inp, dx::Kind::SettleReservation);
        inp.txs.remove(t);
        for x in &mut inp.declared {
            if x.at > t {
                x.at -= 1;
            }
        }
        fails(&inp, "M2 with post-states");
        strip(&mut inp);
        fails(&inp, "M2 genesis");
    }

    #[test]
    fn m03_settle_retained_failure_lamports_inflated_on_chain_fails() {
        let mut inp = cov(Sc::Retained);
        let t = one(&inp, dx::Kind::SettleRetainedFailure);
        strip(&mut inp);
        // move 1000 lamports from the fee payer (key 0) to the last
        // writable program account the chain shows: conserved, but not what
        // the program does
        let b = bal_mut(&mut inp, t);
        let i = (1..b.post.len())
            .find(|&i| b.post[i] > 0 && b.pre[i] != b.post[i])
            .unwrap_or(1);
        b.post[i] += 1000;
        b.post[0] -= 1000;
        fails(&inp, "M3");
    }

    #[test]
    fn m04_settle_forfeit_and_failure_without_the_declared_slot_patch_fail() {
        // Without the patch the archive shows the slot present (the
        // Reveal's post-state) while the chain's balances show it empty
        // before the settlement: VX must not start from the chain's 0
        // lamports (an absent account) and agree.
        for (sc, k) in [
            (Sc::Forfeit, dx::Kind::SettleForfeit),
            (Sc::Failure, dx::Kind::SettleFailure),
        ] {
            let mut inp = cov(sc);
            let t = one(&inp, k);
            let before = inp.declared.len();
            inp.declared.retain(|d| !d.what.contains("arrival slot"));
            assert_eq!(inp.declared.len(), before - 1);
            let rep = fails(&inp, "M4");
            assert!(
                fails_vx(&rep, t, "ReExecMismatch"),
                "{sc:?}: {:?}",
                vx_at(&rep, t)
            );
            strip(&mut inp);
            fails(&inp, "M4 genesis");
        }
    }

    #[test]
    fn m05_settle_failure_without_its_declared_fate_patch_fails() {
        let mut inp = cov(Sc::Failure);
        let t = one(&inp, dx::Kind::SettleFailure);
        inp.declared.retain(|d| !d.what.contains("fate DESTROYED"));
        let rep = fails(&inp, "M5");
        assert!(
            vx_at(&rep, t).iter().any(|f| f.severity == Severity::Fail),
            "{:?}",
            vx_at(&rep, t)
        );
        // and with every patch kept, the honest one stays UNVERIFIABLE
        let rep = not_pass(&cov(Sc::Failure), "M5 honest");
        assert_eq!(rep.verdict, Verdict::Unverifiable);
    }

    #[test]
    fn m06_close_terminal_replayed_twice_fails() {
        let mut inp = cov(Sc::Terminal);
        let t = one(&inp, dx::Kind::CloseTerminal);
        let mut dup = inp.txs[t].clone();
        dup.slot += 1;
        dup.seq += 1;
        inp.txs.insert(t + 1, dup);
        for x in &mut inp.declared {
            if x.at > t {
                x.at += 1;
            }
        }
        strip(&mut inp);
        fails(&inp, "M6");
    }

    #[test]
    fn m07_settle_camp_citizen_underpaid_fails() {
        let mut inp = cov(Sc::Camp);
        let t = one(&inp, dx::Kind::SettleCamp);
        let k = some_program_post(&inp, t).unwrap();
        // every program account it writes: lower the first one's lamports
        edit_post(&mut inp, t, &k, |a| a.lamports -= 1000);
        let rep = fails(&inp, "M7 post-states");
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
        // and on chain: the Citizen (15th instruction account) shown paid
        // less than the program pays it
        let mut inp = cov(Sc::Camp);
        let citizen = acct(&inp, t, 14);
        let i = key_index(&inp, t, &citizen);
        strip(&mut inp);
        let b = bal_mut(&mut inp, t);
        b.post[i] -= 1000;
        b.post[0] += 1000;
        fails(&inp, "M7 genesis");
    }

    #[test]
    fn m08_wide_dissolve_post_owner_forged_fails() {
        for (n, &t) in of_native(&cov(Sc::WideHost), "WideDissolve")
            .iter()
            .enumerate()
        {
            let mut inp = cov(Sc::WideHost);
            let k = some_program_post(&inp, t).unwrap();
            edit_post(&mut inp, t, &k, |a| a.owner = Address::default());
            let rep = fails(&inp, "M8");
            assert!(
                fails_vx(&rep, t, "ReExecMismatch"),
                "dissolve {n}: {:?}",
                vx_at(&rep, t)
            );
        }
    }

    #[test]
    fn m09_wide_return_without_its_dissolve_fails() {
        let mut inp = cov(Sc::WideHost);
        let rt = one_native(&inp, "WideReturn");
        let d = *of_native(&inp, "WideDissolve")
            .iter()
            .rfind(|&&d| d < rt)
            .unwrap();
        inp.txs.remove(d);
        for x in &mut inp.declared {
            if x.at > d {
                x.at -= 1;
            }
        }
        fails(&inp, "M9 post-states");
        strip(&mut inp);
        fails(&inp, "M9 genesis");
    }

    #[test]
    fn m10_wide_disband_stranded_archived_as_failed_fails() {
        let mut inp = cov(Sc::WideHost);
        let t = one_native(&inp, "WideDisbandStranded");
        strip(&mut inp);
        inp.txs[t].err = Some("InstructionError(0, Custom(6))".into());
        inp.txs[t].code = Some(6);
        fails(&inp, "M10");
    }

    #[test]
    fn m11_wide_close_roster_rent_redirected_on_chain_fails() {
        let mut inp = cov(Sc::WideHost);
        let t = one_native(&inp, "WideCloseRoster");
        strip(&mut inp);
        let b = bal_mut(&mut inp, t);
        // the rent refund shown landing on the fee payer instead of rent_to
        let i = (1..b.post.len())
            .find(|&i| b.post[i] > b.pre[i])
            .expect("rent_to credited");
        let moved = b.post[i] - b.pre[i];
        b.post[i] -= moved;
        b.post[0] += moved;
        // (VG: a wallet movement the archive cannot explain is MissingData
        // by its documented rule, verify-pr91; never PASS)
        not_pass(&inp, "M11 genesis");
        // with post-states: the roster shown still open
        let mut inp = cov(Sc::WideHost);
        let (k, _) = inp.txs[t]
            .post
            .iter()
            .find(|(_, a)| a.is_none())
            .cloned()
            .expect("closed");
        let back = inp.txs[..t]
            .iter()
            .rev()
            .find_map(|x| x.post.iter().find(|(y, _)| *y == k).cloned())
            .unwrap();
        inp.txs[t].post.iter_mut().find(|(y, _)| *y == k).unwrap().1 = back.1;
        let rep = fails(&inp, "M11 post-states");
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
    }

    #[test]
    fn m12_a_successful_wide_resident_act_fails() {
        // A WideMuster of the widehost recording rewrapped as an NFT
        // resident's WideResidentAct(Muster), archived as a success.
        let mut inp = cov(Sc::WideHost);
        let t = (0..inp.txs.len())
            .find(|&t| inp.txs[t].err.is_none() && native_at(&inp, t) == Some("WideMuster"))
            .expect("a WideMuster");
        let mut x = tx::from_wire(&inp.txs[t].tx).unwrap();
        let prog = inp.cfg.program;
        let ixr = x
            .message
            .instructions
            .iter_mut()
            .find(|i| x.message.account_keys[i.program_id_index as usize] == prog)
            .unwrap();
        let inner = ixr.data.clone();
        let mut act = vec![0u8; 5 + inner.len()];
        wix::ResidentAct {
            generation: 0,
            inner: &inner,
        }
        .encode_into(&mut act)
        .unwrap();
        ixr.data = act;
        inp.txs[t].tx = tx::wire(&x);
        for strip_posts in [false, true] {
            let mut i2 = inp.clone();
            if strip_posts {
                strip(&mut i2);
            }
            let rep = fails(&i2, "M12");
            assert!(
                rep.findings
                    .iter()
                    .any(|f| f.check == "V0" && f.fail() && f.code == "UnknownInstruction"),
                "{:#?}",
                show(&rep)
            );
        }
    }

    #[test]
    fn m13_a_wide_tx_omitted_before_a_psff_receipt_fails() {
        // VW1's chain skip after a VX transaction carrying a PSFF record is
        // global (any chain whose last record precedes it): omit the wide just before it, one at a
        // time (with and without post-states): each must still FAIL
        // (VX/VWL/VG provenance), not only lose VW1's final-head check.
        let base = cov(Sc::Retained);
        let s = one(&base, dx::Kind::SettleRetainedFailure);
        // the wide (non-dispatch) transactions just before it, whose PSW1
        // records end a chain before the PSFF receipt
        let later: Vec<usize> = (s.saturating_sub(12)..s)
            .filter(|&t| base.txs[t].err.is_none() && native_at(&base, t).is_some())
            .collect();
        assert!(!later.is_empty());
        let mut unver = vec![];
        for &g in &later {
            for stripped in [false, true] {
                let mut inp = base.clone();
                inp.txs.remove(g);
                for x in &mut inp.declared {
                    if x.at > g {
                        x.at -= 1;
                    }
                }
                if stripped {
                    strip(&mut inp);
                }
                let rep = not_pass(&inp, "M13");
                if rep.verdict != Verdict::Fail {
                    unver.push((g, stripped, native_at(&base, g), kind_at(&base, g)));
                }
            }
        }
        assert!(
            unver.is_empty(),
            "omissions judged only UNVERIFIABLE: {unver:?}"
        );
    }
}

// ------------------------------------------- verifier-coverage-2
//
// WideClaimDefence and WideClose(2–5) in VX; the raw ops that can NEVER
// succeed on the PINNED devnet-playable binary are a V0 FAIL (`GateClosed`),
// keyed on that binary's hash; every refusal was observed in the binary
// (the recorder's `Sc::Closes` / `Sc::WideRaw` probes, archived as failed).

mod verifier_coverage_2 {
    use super::*;

    fn strip(inp: &mut Input) {
        for x in inp.txs.iter_mut() {
            x.post.clear();
        }
    }

    /// The failed transactions whose program instruction is a wide command,
    /// with its name and the error.
    fn probes(inp: &Input) -> Vec<(usize, &'static str, String)> {
        (0..inp.txs.len())
            .filter_map(|t| {
                let e = inp.txs[t].err.clone()?;
                let (data, _) = prog_ix(inp, t)?;
                let c = wix::WideCommand::decode(&data).ok()?;
                Some((t, c.name(), e))
            })
            .collect()
    }

    fn gate_closed_at(rep: &Report, t: usize) -> bool {
        rep.findings.iter().any(|f| {
            f.check == "V0" && f.fail() && f.code == "GateClosed" && f.entity == format!("tx#{t}")
        })
    }

    /// The archive with transaction `t` shown as a success.
    fn as_success(inp: &Input, t: usize) -> Input {
        let mut i2 = inp.clone();
        i2.txs[t].err = None;
        i2.txs[t].code = None;
        i2
    }

    /// The probes every recording must hold: (scenario, command, error).
    const PROBES: &[(Sc, &str, &str)] = &[
        (Sc::Closes, "ExpeditionDepart", "Custom(99)"),
        (Sc::Closes, "ExpeditionSettleOrigin", "Custom(99)"),
        (Sc::Closes, "ExpeditionReveal", "Custom(99)"),
        (Sc::Closes, "ExpeditionGather", "Custom(99)"),
        (Sc::Closes, "WideClaimDefence", "Custom(2)"),
        (Sc::Closes, "WideClose", "Custom(2)"),
        (Sc::Closes, "WideDeclareSiege", "Custom(99)"),
        (Sc::Closes, "WideResolveWithConquest", "Custom(99)"),
        (Sc::Closes, "WideSettleCapture", "Custom(99)"),
        (Sc::Closes, "WideCloseCaptureEscrow", "Custom(99)"),
        (Sc::Closes, "WideCloseConquest", "Custom(99)"),
        (Sc::WideRaw, "WideDepart", "Custom(99)"),
    ];

    #[test]
    fn every_gate_is_refused_by_the_pinned_binary_and_archived() {
        for sc in [Sc::Closes, Sc::WideRaw] {
            let inp = cov(sc);
            assert_eq!(
                inp.cfg.program_hash.map(hex::encode).as_deref(),
                Some(MAIN_SHA256)
            );
            let got = probes(&inp);
            for &(s, name, err) in PROBES.iter().filter(|p| p.0 == sc) {
                assert!(
                    got.iter().any(|(_, n, e)| *n == name && e.contains(err)),
                    "{s:?}: no archived refusal of {name} with {err}: {got:?}"
                );
            }
        }
        // the two real season-end closes and the raw WideGather succeeded
        let c = cov(Sc::Closes);
        let closes: Vec<u8> = of_native(&c, "WideClose")
            .into_iter()
            .map(|t| prog_ix(&c, t).unwrap().0[1])
            .collect();
        assert_eq!(closes, vec![wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS]);
        let w = cov(Sc::WideRaw);
        let whats: Vec<u8> = of_native(&w, "WideClose")
            .into_iter()
            .map(|t| prog_ix(&w, t).unwrap().0[1])
            .collect();
        assert!(whats.contains(&wix::CLOSE_WHAT_INPUTS), "{whats:?}");
        assert_eq!(of_native(&w, "WideGather").len(), 1);
    }

    #[test]
    fn the_binary_carries_the_devnet_marker_and_no_localnet_one() {
        // (the gates are build constants: DEPART_DEBIT_ENABLED is true only
        // with `localnet-wide-depart` (marker PSF_LOCALNET_WIDE_DEPART_BUILD)
        // or under cfg(test))
        let so = so();
        let has = |m: &[u8]| so.windows(m.len()).any(|w| w == m);
        assert!(has(b"PSF_DEVNET_PLAYABLE_BUILD"));
        for m in [
            &b"PSF_LOCALNET_WIDE_DEPART_BUILD"[..],
            b"PSF_LOCALNET_EXPEDITION_SBF_BUILD",
            b"PSF_LOCALNET_CONQUEST_SBF_BUILD",
        ] {
            assert!(!has(m), "{}", String::from_utf8_lossy(m));
        }
    }

    #[test]
    fn a_refused_probe_archived_as_a_success_fails() {
        let mut judged = 0;
        for sc in [Sc::Closes, Sc::WideRaw] {
            let inp = cov(sc);
            for (t, name, _) in probes(&inp) {
                if !PROBES.iter().any(|p| p.0 == sc && p.1 == name) {
                    continue;
                }
                judged += 1;
                for strip_posts in [false, true] {
                    let mut i2 = as_success(&inp, t);
                    if strip_posts {
                        strip(&mut i2);
                    }
                    let rep = verify_core::verify(&i2);
                    assert_eq!(rep.verdict, Verdict::Fail, "{sc:?} {name} tx#{t}");
                    assert!(
                        gate_closed_at(&rep, t),
                        "{sc:?} {name} tx#{t} posts stripped {strip_posts}: {:#?}",
                        show(&rep)
                    );
                    if !strip_posts {
                        // and the pinned program, re-executing it, refuses it
                        assert!(
                            fails_vx(&rep, t, "ReExecRefused"),
                            "{sc:?} {name} tx#{t}: {:?}",
                            vx_at(&rep, t)
                        );
                    }
                }
            }
        }
        assert_eq!(judged, PROBES.len());
    }

    #[test]
    fn under_another_pinned_binary_the_gate_rule_does_not_fire_and_nothing_passes() {
        // e.g. a local land build, whose WideDepart runs (#94): V0 must not
        // call these known-bad; without the pinned binary VX cannot decide
        // (UNVERIFIABLE), so the season is never a PASS either.
        let local = [0x6f; 32];
        for sc in [Sc::Closes, Sc::WideRaw] {
            let inp = cov(sc);
            for (t, name, _) in probes(&inp) {
                if !PROBES.iter().any(|p| p.0 == sc && p.1 == name) {
                    continue;
                }
                let mut i2 = as_success(&inp, t);
                i2.cfg.program_hash = Some(local);
                let rep = verify_core::verify(&i2);
                assert!(!gate_closed_at(&rep, t), "{sc:?} {name}: {:#?}", show(&rep));
                assert_ne!(rep.verdict, Verdict::Pass, "{sc:?} {name}");
                assert!(
                    !rep.findings
                        .iter()
                        .any(|f| f.code == "WideUnmodelled" && f.entity == format!("tx#{t}")),
                    "{sc:?} {name}: VX's now, not WideUnmodelled: {:#?}",
                    show(&rep)
                );
            }
        }
        // and a chain that served another binary than the pinned one
        assert!(!verify_core::checks::v0_coverage::pinned_gate_closed(
            Some(hex::decode(MAIN_SHA256).unwrap().try_into().unwrap()),
            &[(1, local)]
        ));
        assert!(verify_core::checks::v0_coverage::pinned_gate_closed(
            Some(hex::decode(MAIN_SHA256).unwrap().try_into().unwrap()),
            &[]
        ));
        assert!(!verify_core::checks::v0_coverage::pinned_gate_closed(
            None,
            &[]
        ));
    }

    /// The WideClose(4) of the raw gather (keeper-signed), its data replaced
    /// by `data` and signed again with the recorder's fixed in-memory keeper
    /// key: a success the program cannot have run.
    fn forged_success(data: Vec<u8>) -> (Input, usize) {
        let mut inp = cov(Sc::WideRaw);
        let t = *of_native(&inp, "WideClose")
            .iter()
            .find(|&&t| prog_ix(&inp, t).unwrap().0[1] == wix::CLOSE_WHAT_INPUTS)
            .unwrap();
        let mut x = tx::from_wire(&inp.txs[t].tx).unwrap();
        let prog = inp.cfg.program;
        let ixr = x
            .message
            .instructions
            .iter_mut()
            .find(|i| x.message.account_keys[i.program_id_index as usize] == prog)
            .unwrap();
        ixr.data = data;
        let keeper = Keypair::new_from_array([0xA3; 32]);
        assert_eq!(x.message.account_keys[0], keeper.pubkey());
        let x = tx::sign(x.message, &[&keeper]).unwrap();
        let old = inp.txs[t].signature.to_string();
        let new = tx::signature(&x);
        inp.txs[t].tx = tx::wire(&x);
        inp.txs[t].signature = new;
        if let Some(b) = inp.chain.balances.remove(&old) {
            inp.chain.balances.insert(new.to_string(), b);
        }
        (inp, t)
    }

    #[test]
    fn a_forged_success_of_each_never_running_command_fails() {
        // the WideRaw probe's real host reference
        let w = cov(Sc::WideRaw);
        let (dt, _, _) = probes(&w)
            .into_iter()
            .find(|p| p.1 == "WideDepart")
            .unwrap();
        let depart = wix::Depart::decode(&prog_ix(&w, dt).unwrap().0).unwrap();
        let seal = depart.seal;
        let cmds: Vec<(&str, Vec<u8>)> = vec![
            ("WideDepart", depart.to_bytes().to_vec()),
            (
                "WideSettleDeparture",
                wix::SettleDeparture {
                    host: depart.host,
                    transit_slot: 0,
                }
                .to_bytes()
                .to_vec(),
            ),
            (
                "WideSettleTransit",
                wix::SettleTransit {
                    transit_slot: 0,
                    commit: [7; 32],
                    seal,
                    beneficiary: [9; 32],
                }
                .to_bytes()
                .to_vec(),
            ),
            (
                "WideClose(5)",
                wix::Close {
                    what: wix::CLOSE_WHAT_TRANSIT,
                }
                .to_bytes()
                .to_vec(),
            ),
            (
                "WideClose(2)",
                wix::Close {
                    what: wix::CLOSE_WHAT_SLOT,
                }
                .to_bytes()
                .to_vec(),
            ),
            (
                "WideClaimDefence",
                wix::ClaimDefence { day: 0, n: 1 }
                    .to_bytes()
                    .unwrap()
                    .to_vec(),
            ),
            (
                "ExpeditionSettleOrigin",
                wix::ExpeditionSettleOrigin { transit_slot: 0 }
                    .to_bytes()
                    .to_vec(),
            ),
            (
                "CloseCaptureEscrow",
                wix::CloseCaptureEscrow.to_bytes().to_vec(),
            ),
        ];
        for (name, data) in cmds {
            assert!(wix::WideCommand::decode(&data).is_ok(), "{name}");
            let (inp, t) = forged_success(data);
            for strip_posts in [false, true] {
                let mut i2 = inp.clone();
                if strip_posts {
                    strip(&mut i2);
                }
                let rep = verify_core::verify(&i2);
                assert_eq!(rep.verdict, Verdict::Fail, "{name}");
                assert!(gate_closed_at(&rep, t), "{name}: {:#?}", show(&rep));
            }
        }
    }

    #[test]
    fn a_forged_raw_gather_and_forged_closes_fail() {
        // WideGather is NOT gate-closed (it runs): a forged success is VX's
        let mut inp = cov(Sc::WideRaw);
        let t = of_native(&inp, "WideGather")[0];
        let k = program_post(&inp, t);
        edit_post(&mut inp, t, &k, |a| a.data[40] ^= 1);
        let rep = verify_core::verify(&inp);
        assert_eq!(rep.verdict, Verdict::Fail);
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
        assert!(!gate_closed_at(&rep, t));
        // the expedition's ArrivalDay close shown leaving the day open
        let mut inp = cov(Sc::Closes);
        let t = of_native(&inp, "WideClose")[0];
        let (k, _) = inp.txs[t]
            .post
            .iter()
            .find(|(_, a)| a.is_none())
            .cloned()
            .expect("the day closed");
        let back = inp.txs[..t]
            .iter()
            .rev()
            .find_map(|x| x.post.iter().find(|(y, _)| *y == k).cloned())
            .unwrap();
        inp.txs[t].post.iter_mut().find(|(y, _)| *y == k).unwrap().1 = back.1;
        let rep = verify_core::verify(&inp);
        assert_eq!(rep.verdict, Verdict::Fail);
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
        // the ClashInputs close archived before the ArrivalDay close's
        // season end: replayed twice (genesis)
        let mut inp = cov(Sc::Closes);
        strip(&mut inp);
        let t = of_native(&inp, "WideClose")[1];
        let dup = inp.txs[t].clone();
        inp.txs.insert(t + 1, dup);
        let rep = verify_core::verify(&inp);
        assert_ne!(rep.verdict, Verdict::Pass);
        assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    }

    /// Evidence only (not CI): the `Sc::WideRaw` run on a LOCAL land `.so`
    /// (`localnet-wide-depart`, #94), whose raw WideDepart succeeds: set
    /// `PSF_LOCAL_LAND_SO` (the `.so`) and `PSF_LOCAL_WIDERAW` (the
    /// recorder's `playable-local-wideraw.json.gz`). V0's gate rule must not
    /// fire, and VX re-executes the WideDepart exactly.
    #[test]
    #[ignore = "needs a local land .so and its recording: PSF_LOCAL_LAND_SO, PSF_LOCAL_WIDERAW"]
    fn on_a_local_land_binary_the_raw_wide_depart_is_not_a_fail() {
        let so = std::fs::read(std::env::var("PSF_LOCAL_LAND_SO").unwrap()).unwrap();
        let mut inp = Input::load(std::path::Path::new(
            &std::env::var("PSF_LOCAL_WIDERAW").unwrap(),
        ))
        .unwrap();
        assert_eq!(inp.cfg.program_hash, Some(common::sha2_256(&so)));
        assert_ne!(
            inp.cfg.program_hash.map(hex::encode).as_deref(),
            Some(MAIN_SHA256)
        );
        inp.program_so = Some(std::sync::Arc::new(so));
        let t = of_native(&inp, "WideDepart");
        assert_eq!(t.len(), 1, "one successful raw WideDepart");
        let t = t[0];
        for strip_posts in [false, true] {
            let mut i2 = inp.clone();
            if strip_posts {
                strip(&mut i2);
            }
            let rep = verify_core::verify(&i2);
            for f in &rep.findings {
                println!(
                    "posts-stripped {strip_posts}: {:?} {} {} {} {}",
                    f.severity,
                    f.check,
                    f.code,
                    f.entity,
                    f.detail.chars().take(200).collect::<String>()
                );
            }
            assert!(!rep.findings.iter().any(|f| f.fail()), "no FAIL");
            assert!(!gate_closed_at(&rep, t));
            assert!(vx_at(&rep, t).is_empty(), "{:?}", vx_at(&rep, t));
        }
    }
}

/// verify-pr100 (independent review of #100): the reviewer's own mutations
/// of the `Sc::Closes` / `Sc::WideRaw` recordings, and of a recording made
/// on a LOCAL land `.so` (`localnet-wide-depart`), none of which may PASS.
mod verify_pr100 {
    use super::*;

    fn strip(inp: &mut Input) {
        for x in inp.txs.iter_mut() {
            x.post.clear();
        }
    }

    fn fails(inp: &Input, what: &str) -> Report {
        let rep = verify_core::verify(inp);
        assert_eq!(rep.verdict, Verdict::Fail, "{what}: {:#?}", show(&rep));
        rep
    }

    fn not_pass(inp: &Input, what: &str) -> Report {
        let rep = verify_core::verify(inp);
        assert_ne!(rep.verdict, Verdict::Pass, "{what}: {:#?}", show(&rep));
        rep
    }

    fn gate_closed_any(rep: &Report) -> bool {
        rep.findings
            .iter()
            .any(|f| f.check == "V0" && f.code == "GateClosed")
    }

    fn close_of(inp: &Input, what: u8) -> usize {
        *of_native(inp, "WideClose")
            .iter()
            .find(|&&t| prog_ix(inp, t).unwrap().0[1] == what)
            .unwrap_or_else(|| panic!("a successful WideClose({what})"))
    }

    fn devnet_hash() -> [u8; 32] {
        hex::decode(MAIN_SHA256).unwrap().try_into().unwrap()
    }

    /// The reviewer's local land recording and its `.so`
    /// (`PSF_LOCAL_LAND_SO`, `PSF_LOCAL_WIDERAW`), or `None` (CI).
    fn local() -> Option<Input> {
        let so = std::fs::read(std::env::var("PSF_LOCAL_LAND_SO").ok()?).unwrap();
        let mut inp = Input::load(std::path::Path::new(
            &std::env::var("PSF_LOCAL_WIDERAW").ok()?,
        ))
        .unwrap();
        assert_eq!(inp.cfg.program_hash, Some(common::sha2_256(&so)));
        inp.program_so = Some(std::sync::Arc::new(so));
        Some(inp)
    }

    /// R1: the ArrivalDay close's archived receipt gains a log line the
    /// program does not write.
    #[test]
    fn r01_day_close_extra_log_line_fails() {
        let mut inp = cov(Sc::Closes);
        let t = close_of(&inp, wix::CLOSE_WHAT_DAY);
        let n = inp.txs[t].logs.len() - 1;
        inp.txs[t]
            .logs
            .insert(n, "Program log: refund doubled".into());
        let rep = fails(&inp, "R1");
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
    }

    /// R2: the ClashInputs close moved before the Season's end (first
    /// position after its creating gather is not needed: anywhere earlier
    /// than EndSeason) — the program refuses it there.
    #[test]
    fn r02_inputs_close_moved_before_season_end_fails() {
        let mut inp = cov(Sc::Closes);
        let t = close_of(&inp, wix::CLOSE_WHAT_INPUTS);
        let x = inp.txs.remove(t);
        let to = inp.txs.len() / 3;
        inp.txs.insert(to, x);
        not_pass(&inp, "R2");
        fails(&inp, "R2");
    }

    /// R3: the ClashInputs close's rent shown going to the fee payer on
    /// chain (the balances), not to the record's immutable recipient.
    #[test]
    fn r03_inputs_close_rent_redirected_on_chain_fails() {
        let mut inp = cov(Sc::Closes);
        let t = close_of(&inp, wix::CLOSE_WHAT_INPUTS);
        strip(&mut inp);
        let s = inp.txs[t].signature.to_string();
        let b = inp.chain.balances.get_mut(&s).unwrap();
        // (the recipient may be the fee payer itself, key 0: the keeper
        // funded the record's rent)
        let i = (0..b.post.len())
            .find(|&i| b.post[i] > b.pre[i])
            .expect("a credited recipient");
        // part of it left in the closed record (writable, debited): a
        // close that did not close; conserved. (Onto a read-only account
        // it is VG's UNVERIFIABLE: not a chain's balances.)
        let j = (0..b.post.len())
            .find(|&j| j != i && b.pre[j] > b.post[j])
            .expect("the closed record");
        b.post[i] -= 1000;
        b.post[j] += 1000;
        fails(&inp, "R3");
    }

    /// R4: the raw WideGather omitted from the WideRaw archive (its
    /// ClashInputs then appear from nowhere for the resolve and the close).
    #[test]
    fn r04_raw_gather_omitted_fails() {
        let mut inp = cov(Sc::WideRaw);
        let t = of_native(&inp, "WideGather")[0];
        inp.txs.remove(t);
        not_pass(&inp, "R4");
        let mut s = inp.clone();
        strip(&mut s);
        not_pass(&s, "R4 stripped");
    }

    /// R5: the ArrivalDay close replayed twice (the second has nothing to
    /// close), with and without post-states.
    #[test]
    fn r05_day_close_replayed_twice_fails() {
        for strip_posts in [false, true] {
            let mut inp = cov(Sc::Closes);
            let t = close_of(&inp, wix::CLOSE_WHAT_DAY);
            let dup = inp.txs[t].clone();
            inp.txs.insert(t + 1, dup);
            if strip_posts {
                strip(&mut inp);
            }
            fails(&inp, "R5");
        }
    }

    /// R6: the WideRaw WideDepart probe shown as a success while the
    /// archive observed NO deployment: still FAIL (V0 GateClosed against
    /// the pin; VX: the pinned binary refuses it), never PASS.
    #[test]
    fn r06_gated_depart_success_with_no_observed_deployment_fails() {
        let mut inp = cov(Sc::WideRaw);
        let t = (0..inp.txs.len())
            .find(|&t| inp.txs[t].err.is_some() && native_at(&inp, t) == Some("WideDepart"))
            .unwrap();
        inp.txs[t].err = None;
        inp.txs[t].code = None;
        inp.program_hashes.clear();
        let rep = fails(&inp, "R6");
        assert!(gate_closed_any(&rep));
    }

    /// R7: a gated success where the chain served ANOTHER binary than the
    /// pinned devnet one: V0's gate rule is silent (V2's mismatch FAILs).
    #[test]
    fn r07_gated_success_on_an_observed_other_binary_is_v2s_fail_not_v0s() {
        let mut inp = cov(Sc::WideRaw);
        let t = (0..inp.txs.len())
            .find(|&t| inp.txs[t].err.is_some() && native_at(&inp, t) == Some("WideDepart"))
            .unwrap();
        inp.txs[t].err = None;
        inp.txs[t].code = None;
        inp.program_hashes = vec![(0, [0x6f; 32])];
        let rep = fails(&inp, "R7");
        assert!(!gate_closed_any(&rep), "{:#?}", show(&rep));
        assert!(rep
            .findings
            .iter()
            .any(|f| f.check == "V2" && f.code == "ProgramMismatch" && f.fail()));
    }

    /// R8: the ClashInputs close's post-state shows the record still open
    /// with its data (the program closed it).
    #[test]
    fn r08_inputs_close_shown_leaving_the_record_fails() {
        let mut inp = cov(Sc::Closes);
        let t = close_of(&inp, wix::CLOSE_WHAT_INPUTS);
        let (k, _) = inp.txs[t]
            .post
            .iter()
            .find(|(_, a)| a.as_ref().is_none_or(|a| a.lamports == 0))
            .cloned()
            .expect("the inputs closed");
        let back = inp.txs[..t]
            .iter()
            .rev()
            .find_map(|x| x.post.iter().find(|(y, _)| *y == k).cloned())
            .unwrap();
        inp.txs[t].post.iter_mut().find(|(y, _)| *y == k).unwrap().1 = back.1;
        let rep = fails(&inp, "R8");
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
    }

    /// R9: the raw WideGather's archived failure flag set (archived as
    /// failed though the program ran it): what follows leans on its
    /// ClashInputs.
    #[test]
    fn r09_raw_gather_archived_as_failed_is_not_a_pass() {
        let mut inp = cov(Sc::WideRaw);
        let t = of_native(&inp, "WideGather")[0];
        inp.txs[t].err = Some("InstructionError(0, Custom(2))".into());
        inp.txs[t].code = Some(2);
        not_pass(&inp, "R9");
    }

    /// R10 (local land .so, evidence only): the honest recording has no
    /// FAIL and no GateClosed; re-pinned to the devnet binary it FAILs;
    /// the WideDepart's transit post-state forged FAILs; the devnet `.so`
    /// given under the local pin never PASSes and is no GateClosed.
    #[test]
    #[ignore = "needs PSF_LOCAL_LAND_SO and PSF_LOCAL_WIDERAW (the reviewer's local recording)"]
    fn r10_local_land_recording_honest_and_mutated() {
        let inp = local().expect("PSF_LOCAL_LAND_SO / PSF_LOCAL_WIDERAW");
        let t = of_native(&inp, "WideDepart");
        assert_eq!(t.len(), 1);
        let t = t[0];
        for strip_posts in [false, true] {
            let mut i2 = inp.clone();
            if strip_posts {
                strip(&mut i2);
            }
            let rep = verify_core::verify(&i2);
            println!(
                "honest posts-stripped {strip_posts}: {:?} {:#?}",
                rep.verdict,
                show(&rep)
            );
            assert!(!rep.findings.iter().any(|f| f.fail()), "no FAIL");
            assert!(!gate_closed_any(&rep));
            assert!(vx_at(&rep, t).is_empty(), "{:?}", vx_at(&rep, t));
        }
        // (a) re-pinned to the devnet binary (the local recording judged as
        // if it claimed to be devnet-playable)
        let mut i2 = inp.clone();
        i2.cfg.program_hash = Some(devnet_hash());
        i2.program_so = Some(so());
        let rep = fails(&i2, "R10a");
        assert!(gate_closed_any(&rep) || fails_vx(&rep, t, "ReExecRefused"));
        // (b) the WideDepart's created transit record forged
        let mut i2 = inp.clone();
        let k = i2.txs[t]
            .post
            .iter()
            .find(|(_, a)| {
                a.as_ref().is_some_and(|a| {
                    a.owner == i2.cfg.program
                        && a.data.len() == frontier_abi::world_index::march::WIDE_TRANSIT_LEN
                })
            })
            .map(|(k, _)| *k)
            .expect("the 288-byte transit record");
        let a = i2.txs[t]
            .post
            .iter_mut()
            .find(|(y, _)| *y == k)
            .unwrap()
            .1
            .as_mut()
            .unwrap();
        a.data[100] ^= 1;
        let rep = fails(&i2, "R10b");
        assert!(fails_vx(&rep, t, "ReExecMismatch"), "{:?}", vx_at(&rep, t));
        // (c) the devnet .so given under the local pin: VX cannot judge
        let mut i2 = inp.clone();
        i2.program_so = Some(so());
        let rep = not_pass(&i2, "R10c");
        assert!(!gate_closed_any(&rep));
        // (d) the WideDepart's escrow shown going to the payer on chain
        let mut i2 = inp.clone();
        strip(&mut i2);
        let s = i2.txs[t].signature.to_string();
        let b = i2.chain.balances.get_mut(&s).unwrap();
        let i = (1..b.post.len())
            .find(|&i| b.post[i] > b.pre[i])
            .expect("a credited account");
        b.post[i] -= 1;
        b.post[0] += 1;
        fails(&i2, "R10d");
    }
}
