//! VWL on a `.so` built from CURRENT MAIN (Q16-1 = A continued, 2026-11-19,
//! after #72): the recordings behind
//!
//! * the WideSetRules keep-holder gate of #38 (D-verify-pr72-9),
//! * the season-end WideClose of a wide ticket record, a wide holding and
//!   a wide province,
//! * the wide economy (Harvest / Build / Train) and WideGarrison.
//!
//! One recording of the devnet-playable `.so` built from `origin/main`
//! `1c55036b` (sha256 70b41975…; `scripts/build-frontier-devnet-playable-sbf.sh`)
//! in the in-process LiteSVM chain (`localnet::Chain`), made by
//! `record_playable_wide_next` (ignored; needs the artefact). Unlike the
//! earlier recorders it keeps the feed **unfiltered**: every writable
//! account's post-state, wallets included, and their finals
//! (D-verify-pr72-10).
//!
//! 1. `playable-next-setrules.json.gz`: a REAL season by its own
//!    instructions whose conquest block has `placement = 2` (mixed): three
//!    players' Join + PlaceHome, a **refused** WideSetRules naming
//!    OrbitBalanced (the program refuses `BadData`; archived, not judged),
//!    then the authority's WideSetRules naming MixedInterleaved. Judged as
//!    a whole season.
//! 2. The wide land and the claims as `playable_wide_claims.rs` makes them
//!    (the same two **declared patches**: RingSeed(128) + the Frontier's
//!    wedge counters; the players' final Town homes at the rim (128, 0) and
//!    THE anchor + SeedCache of each ticket bell), witnessed as
//!    `playable-next-claims-segment.json.gz` + `…-snapshot.json.gz`.
//! 3. A third **declared patch**: the wide province's `resolved_next` set
//!    to the current bell (what WideResolve, which this verifier does not
//!    model, would have left), the first wide holding's stores filled and a
//!    Spearman reserve given. Then, all REAL and witnessed as
//!    `playable-next-segment.json.gz` + `…-snapshot.json.gz`: the wide
//!    economy and garrison, a slot-3 filing left pending, EndSeason at the
//!    end bell, and 72 h later the WideCloses (a pending ticket, a Settled
//!    one with its escrow, a Settled one without; two holdings; the
//!    province).
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_WIDE_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_wide_next -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::ports::Account;
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::layout::player::{accrual as AC, citizen as C, holding as H, holding_ref as HR};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS, season as S};
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use frontier_abi::world_index::{
    economy::Action,
    holding as wh,
    land::{self as wl, WideProvince},
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    ticket as wt, wide_ix as wix, WideCoord,
};
use permutation_rules::frontier::beacon::{
    self as kb, genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time,
    BeaconClock, WindowSchedule,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord, PLACEMENT_MIXED};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use verify_core::checks::vwl_wide_land as vwl;
use verify_core::input::{Config, Input};

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
/// The devnet-playable `.so` built from `origin/main` `1c55036b`.
const MAIN_SHA256: &str = "70b41975750e2d369ecae0eed89395e6235896e56e009c0bfb554f2b9c42ebfc";
const RULES: wr::RuleBytes = wr::RuleBytes {
    keep_holder: KeepHolderRule::MixedInterleaved as u8,
    free_city: FreeCityRule::CanonicalHashV1 as u8,
    camp: CampRule::SortKeyDrawV1 as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
const OPENINGS: [(i64, i64); 3] = [(129, 0), (129, -1), (128, 1)];
/// The legacy rim province the players' first homes are patched into.
const RIM: (i32, i32) = (128, 0);
/// Stores of a patched rim home, milli-units per resource.
const STORES: i64 = 5_000_000_000;

fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
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
        heap: None,
    }
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
    snapshot: Option<BTreeMap<[u8; 32], Option<Account>>>,
    written: std::collections::BTreeSet<[u8; 32]>,
}

impl Rec {
    fn try_send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) -> bool {
        if let Some(snap) = self.snapshot.as_mut() {
            for i in ixs {
                for m in &i.accounts {
                    let k = m.pubkey.to_bytes();
                    if self.written.contains(&k) || snap.contains_key(&k) {
                        continue;
                    }
                    // Unfiltered: wallets too, as a real witness would.
                    snap.insert(k, self.c.account(&m.pubkey));
                }
            }
        }
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
        if ok && self.snapshot.is_some() {
            for i in ixs {
                for m in i.accounts.iter().filter(|m| m.is_writable) {
                    self.written.insert(m.pubkey.to_bytes());
                }
            }
        }
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
    fn patch(&mut self, k: [u8; 32], data: Vec<u8>, what: &str) {
        let a = Account {
            lamports: 1_000_000_000,
            data,
            owner: self.a.program,
            executable: false,
        };
        self.c.set_account(adr(k), a).expect("patch");
        self.log.push(format!("PATCH (set_account): {what}"));
    }
    fn edit(&mut self, k: [u8; 32], what: &str, f: impl FnOnce(&mut Vec<u8>)) {
        let mut a = self.c.account(&adr(k)).expect("an account to patch");
        f(&mut a.data);
        self.c.set_account(adr(k), a).expect("patch");
        self.log.push(format!("PATCH (set_account): {what}"));
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

/// 0xD9 WideClaimSite for `m` at `(coord, site)` into `slot`; `prev` the
/// slot-2 wide holding for a slot-3 claim.
fn claim_ix(
    a: &Addresses,
    m: &Member,
    coord: WideCoord,
    site: u8,
    slot: u8,
    prev: Option<(WideCoord, u8)>,
) -> Instruction {
    let c = ctx_of(a);
    let w = m.wallet.pubkey();
    let anchor = adr(c.holding(RIM.0, RIM.1, m.rim_site));
    let anchor_p = adr(c.province(RIM.0, RIM.1));
    let (ph, pp) = match prev {
        Some((pc, ps)) => (
            adr(wh::holding_address(&c, pc, ps)),
            adr(wl::province_address(&c, pc)),
        ),
        None => (anchor, anchor_p),
    };
    wide_ix(
        a,
        vec![
            AccountMeta::new_readonly(w, true),
            AccountMeta::new(w, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(m.citizen), false),
            AccountMeta::new_readonly(a.frontier(), false),
            AccountMeta::new(adr(wl::province_address(&c, coord)), false),
            AccountMeta::new(adr(wt::ticket_address(&c, &m.citizen)), false),
            AccountMeta::new(anchor, false),
            AccountMeta::new_readonly(anchor_p, false),
            AccountMeta::new(ph, false),
            AccountMeta::new_readonly(pp, false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::ClaimSite {
            p: coord.p(),
            q: coord.q(),
            site,
            slot,
        }
        .to_bytes()
        .to_vec(),
    )
}

/// 0xDC WideSettleTicket(0) for `m`'s ticket; `disp` the displaced
/// holding's rent payer and owner.
#[allow(clippy::too_many_arguments)]
fn settle_ix(
    a: &Addresses,
    payer: &Address,
    m: &Member,
    coord: WideCoord,
    site: u8,
    bell: u32,
    region: u8,
    disp: Option<(Address, &Member)>,
) -> Instruction {
    let c = ctx_of(a);
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(m.citizen), false),
        AccountMeta::new(adr(wt::ticket_address(&c, &m.citizen)), false),
        AccountMeta::new(adr(wh::holding_address(&c, coord, site)), false),
        AccountMeta::new(adr(wl::province_address(&c, coord)), false),
        AccountMeta::new(a.join_shard(m.faction, m.shard), false),
        AccountMeta::new_readonly(adr(c.seed_cache(bell, region, 0)), false),
        AccountMeta::new_readonly(adr(c.bell_anchor(bell, region)), false),
    ];
    if let Some((dp, loser)) = disp {
        accounts.push(AccountMeta::new(dp, false));
        accounts.push(AccountMeta::new(adr(loser.citizen), false));
        accounts.push(AccountMeta::new(
            a.join_shard(loser.faction, loser.shard),
            false,
        ));
    }
    accounts.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    wide_ix(a, accounts, wix::SettleTicket { k: 0 }.to_bytes().to_vec())
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

#[test]
#[ignore = "needs the devnet-playable .so built from main: set PSF_PLAYABLE_SO (sha256 70b41975…), run with --ignored"]
fn record_playable_wide_next() {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert_eq!(
        hex::encode(so_hash),
        MAIN_SHA256,
        "not the devnet-playable build of main 1c55036b"
    );
    assert_eq!(localnet::bls_and_sbpf_v2_active(), (true, true));

    let rounds = FixtureDrand::load(&fb::fixture_dir(), fb::quicknet_info())
        .expect("fixture rounds verify")
        .rounds;
    let (&round, beacon) = rounds.iter().next().expect("a round");
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
        snapshot: None,
        written: Default::default(),
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
    let (nat_txs, nat_finals) = r.archive(0, &program);
    let natural = input_of(
        program,
        so_hash,
        nat_txs,
        nat_finals,
        r.c.slot(),
        format!(
            "verify/tests/playable_wide_next.rs record_playable_wide_next: the devnet-playable .so built from origin/main 1c55036b (sha256 {MAIN_SHA256}) in localnet::Chain (LiteSVM, in process), a real season by its own instructions at program version 0x4804 with conquest placement 2 (genesis on the shipped quicknet round {round}), three players' Join + PlaceHome, a refused WideSetRules(OrbitBalanced) and the authority's WideSetRules(MixedInterleaved); the UNFILTERED feed (wallet post-states and finals included); steps: {}",
            r.log.join("; ")
        ),
        "playable-next-setrules",
    );
    let rep = verify_core::verify(&natural);
    for f in &rep.findings {
        println!(
            "natural {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    println!("natural verdict {:?}", rep.verdict);

    // ---- 2. The wide land (patch 1, then real).
    let model_ring = adr(ctx.ring_seed(cq.heartland_max_ring as u16));
    let mut rs = r.c.account(&model_ring).expect("a real seeded RingSeed");
    assert_eq!(rs.data[RS::STATUS], RS::STATUS_SEEDED);
    rs.data[RS::D..RS::D + 2].copy_from_slice(&128u16.to_le_bytes());
    rs.data[RS::OPENED_BELL..RS::OPENED_BELL + 4].copy_from_slice(&0u32.to_le_bytes());
    r.c.set_account(adr(ctx.ring_seed(128)), rs)
        .expect("patch: RingSeed(128)");
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
    r.log
        .push("PATCH (set_account): RingSeed(128) seeded, opened_bell 0".into());
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
    let (hp, hq, _) = homes[0];
    let mut pd = r
        .data(&a.province(hp.into(), hq.into()))
        .expect("a real v2 Province");
    {
        use frontier_abi::v2::layout::province::province as P2;
        pd[P2::P..P2::P + 2].copy_from_slice(&(RIM.0 as i16).to_le_bytes());
        pd[P2::Q..P2::Q + 2].copy_from_slice(&(RIM.1 as i16).to_le_bytes());
    }
    for i in 0..PV::SITES_N {
        let o = PV::site(i);
        pd[o..o + SM::SIZE].fill(0);
        pd[o + SM::STATE] = SM::STATE_FREE;
        pd[o + SM::FACTION] = permutation_rules::frontier::clash::NEUTRAL;
        pd[o + SM::PEND0_BELL..o + SM::PEND0_BELL + 4].copy_from_slice(&SM::NO_BELL.to_le_bytes());
        pd[o + SM::PEND1_BELL..o + SM::PEND1_BELL + 4].copy_from_slice(&SM::NO_BELL.to_le_bytes());
    }
    pd[PV::N_SITES_USED] = 0;
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
    r.patch(
        rim_prov,
        pd,
        "a v2 Province at the rim (128,0) mirroring the three homes",
    );

    // ---- 4. The witnessed claims segment (as playable_wide_claims.rs,
    // shorter): three filings in one bell, two fresh settles, one expiry.
    let seg_a_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    r.snapshot = Some(BTreeMap::new());
    r.written.clear();
    let p0 = opened[0];
    let p1 = opened[1];
    let region_of = |r: &Rec, coord: WideCoord| -> u8 {
        WideProvince::read(&r.data(&adr(wl::province_address(&ctx, coord))).unwrap())
            .unwrap()
            .region
    };
    let reg0 = region_of(&r, p0);
    let bell_now = |r: &Rec| -> u32 {
        frontier_abi::prologue::bell_at(genesis_ts, r.c.unix_timestamp()).unwrap()
    };
    let free_sites = |r: &Rec, coord: WideCoord| -> Vec<u8> {
        let d = r.data(&adr(wl::province_address(&ctx, coord))).unwrap();
        (0..d[PV::SITE_COUNT])
            .filter(|&s| {
                let o = PV::site(s as usize);
                let ro = frontier_abi::v2::layout::province::province::record(s as usize);
                d[o + SM::STATE] == SM::STATE_FREE && d[ro..ro + 32].iter().all(|b| *b == 0)
            })
            .collect()
    };
    let sites0 = free_sites(&r, p0);
    assert!(sites0.len() >= 3, "free sites of {p0:?}: {sites0:?}");
    let b0 = bell_now(&r);
    for i in 0..3usize {
        r.send(
            &[&members[i].wallet],
            &[claim_ix(&a, &members[i], p0, sites0[i], 2, None)],
            &format!(
                "WideClaimSite player {i} ({p0:?}, site {}) slot 2",
                sites0[i]
            ),
        );
    }
    assert_eq!(bell_now(&r), b0, "the three filings share one bell");
    let final0 = stage_seed(&mut r, b0, reg0, [0x5Au8; 32]);
    for i in 0..2usize {
        r.send(
            &[&payer],
            &[settle_ix(
                &a,
                &payer.pubkey(),
                &members[i],
                p0,
                sites0[i],
                b0,
                reg0,
                None,
            )],
            &format!("WideSettleTicket player {i} (fresh)"),
        );
    }
    r.advance_to(genesis_ts + 600 * (b0 as i64 + 24) + 5);
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[2],
            p0,
            sites0[2],
            b0,
            reg0,
            None,
        )],
        "WideSettleTicket player 2 (expired)",
    );
    r.advance_to(final0.max(r.c.unix_timestamp()) + 5);
    let snap_a = r.snapshot.take().unwrap();
    let (a_txs, a_finals) = r.archive(seg_a_from, &program);
    let prov_common = format!(
        "verify/tests/playable_wide_next.rs record_playable_wide_next: the devnet-playable .so built from origin/main 1c55036b (sha256 {MAIN_SHA256}) in localnet::Chain (LiteSVM, in process); a real placement-2 season by its own instructions, the declared wide land patch (RingSeed(128), Frontier wedge counters) and the real ring-129 opening, the declared claims patch (three players' PlaceHome holdings copied to the rim (128,0) as final Towns with stores, a v2 Province there, the Citizens' slot 1 re-pointed; THE anchor and SeedCache of each ticket bell with a literal seed); the UNFILTERED feed (wallet post-states, witness states and finals included)"
    );
    let seg_a = input_of(
        program,
        so_hash,
        a_txs,
        a_finals,
        r.c.slot(),
        format!(
            "{prov_common}; the witnessed claims segment; steps: {}",
            r.log.join("; ")
        ),
        "playable-next-claims-segment",
    );
    let snap_a = input_of(
        program,
        so_hash,
        vec![],
        snap_a,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the claims segment names, read before its first use; {prov_common}"),
        "playable-next-claims-snapshot",
    );
    let found_a = vwl::judge_segment(&seg_a, &snap_a.finals);
    for f in &found_a {
        println!(
            "claims segment {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }

    // ---- 5. Patch 3: what WideResolve (not modelled) would have left, and
    // the means of the economy.
    let now_b = bell_now(&r);
    r.edit(
        wl::province_address(&ctx, p0),
        &format!("wide province {p0:?} resolved_next = bell {now_b} (stands in for WideResolve)"),
        |d| d[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&now_b.to_le_bytes()),
    );
    let h0 = wh::holding_address(&ctx, p0, sites0[0]);
    r.edit(
        h0,
        "player 0's wide holding: stores filled, 40 Spearmen in reserve",
        |d| {
            for res in 0..RESOURCES {
                let so = H::store(res);
                d[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&STORES.to_le_bytes());
                let cap = i64::from_le_bytes(d[so + AC::CAP..so + AC::CAP + 8].try_into().unwrap());
                if cap < STORES {
                    d[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&STORES.to_le_bytes());
                }
            }
            let ro = H::reserve(0);
            d[ro..ro + 4].copy_from_slice(&40u32.to_le_bytes());
        },
    );

    // ---- 6. The witnessed segment: economy, garrison, the season's end,
    // the closes.
    let seg_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    r.snapshot = Some(BTreeMap::new());
    r.written.clear();
    let m0 = &members[0];
    let s0 = sites0[0];
    for (action, what) in [
        (Action::Harvest, "Harvest (the lazy finality flip)"),
        (Action::Build { item: 0 }, "Build item 0"),
        (Action::Build { item: 6 }, "Build walls (mirror)"),
        (Action::Train { unit: 0, n: 5 }, "Train 5 Spearmen"),
        (Action::Build { item: 7 }, "Build the tier-up (mirror)"),
        (Action::Harvest, "Harvest again"),
    ] {
        r.try_send(
            &[&m0.wallet],
            &[economy_ix(&a, m0, p0, s0, action)],
            &format!("WideEconomy player 0: {what}"),
        );
    }
    r.try_send(
        &[&m0.wallet],
        &[garrison_ix(&a, m0, p0, s0, 7)],
        "WideGarrison player 0: +7",
    );
    r.try_send(
        &[&m0.wallet],
        &[garrison_ix(&a, m0, p0, s0, 3)],
        "WideGarrison player 0: +3",
    );
    r.try_send(
        &[&members[1].wallet],
        &[economy_ix(&a, &members[1], p0, sites0[1], Action::Harvest)],
        "WideEconomy player 1: Harvest (unpatched holding)",
    );
    // Honest refusals (archived, not judged).
    r.try_send(
        &[&members[2].wallet],
        &[economy_ix(&a, &members[2], p0, s0, Action::Harvest)],
        "WideEconomy by a Citizen that does not own the holding (refused)",
    );
    r.try_send(
        &[&m0.wallet],
        &[garrison_ix(&a, m0, p0, s0, 1_000)],
        "WideGarrison above the reserve (refused)",
    );
    // A slot-3 filing left pending to the season's end.
    let sites1 = free_sites(&r, p1);
    assert!(!sites1.is_empty(), "free sites of {p1:?}");
    r.send(
        &[&members[1].wallet],
        &[claim_ix(
            &a,
            &members[1],
            p1,
            sites1[0],
            3,
            Some((p0, sites0[1])),
        )],
        "WideClaimSite player 1 slot 3 (left pending)",
    );
    r.try_send(
        &[&payer],
        &[close_holding_ix(
            &a,
            &payer.pubkey(),
            p0,
            s0,
            m0.wallet.pubkey(),
        )],
        "WideClose(holding) while Running (refused)",
    );
    // The season's end.
    let end_ts = genesis_ts + 600 * p.base.end_bell as i64;
    r.advance_to(end_ts + 5);
    r.send(
        &[&payer],
        &[ix::end_season(&a, payer.pubkey())],
        "EndSeason",
    );
    r.try_send(
        &[&payer],
        &[close_holding_ix(
            &a,
            &payer.pubkey(),
            p0,
            s0,
            m0.wallet.pubkey(),
        )],
        "WideClose(holding) before end + 72 h (refused)",
    );
    r.advance_to(end_ts + 72 * 3_600 + 5);
    // The tickets: pending (escrow → funder, marker cleared), Settled with
    // its escrow (expired), Settled without (won).
    let w = |i: usize| members[i].wallet.pubkey();
    r.send(
        &[&payer],
        &[close_ticket_ix(
            &a,
            &payer.pubkey(),
            members[1].citizen,
            w(1),
            Some(w(1)),
        )],
        "WideClose(ticket) player 1: pending",
    );
    r.send(
        &[&payer],
        &[close_ticket_ix(
            &a,
            &payer.pubkey(),
            members[2].citizen,
            w(2),
            Some(w(2)),
        )],
        "WideClose(ticket) player 2: Settled, escrow retained",
    );
    r.try_send(
        &[&payer],
        &[close_ticket_ix(
            &a,
            &payer.pubkey(),
            members[0].citizen,
            w(0),
            Some(w(0)),
        )],
        "WideClose(ticket) player 0 with a funder but no escrow (refused)",
    );
    r.send(
        &[&payer],
        &[close_ticket_ix(
            &a,
            &payer.pubkey(),
            members[0].citizen,
            w(0),
            None,
        )],
        "WideClose(ticket) player 0: Settled, no escrow",
    );
    r.try_send(
        &[&payer],
        &[close_ticket_ix(
            &a,
            &payer.pubkey(),
            members[0].citizen,
            w(0),
            None,
        )],
        "WideClose(ticket) again (refused)",
    );
    for (i, &site) in sites0.iter().enumerate().take(2) {
        r.send(
            &[&payer],
            &[close_holding_ix(&a, &payer.pubkey(), p0, site, w(i))],
            &format!("WideClose(holding) player {i}"),
        );
    }
    for coord in [p0, p1] {
        r.send(
            &[&payer],
            &[close_province_ix(&a, &payer.pubkey(), coord)],
            &format!("WideClose(province) {coord:?}"),
        );
    }
    let snapshot = r.snapshot.take().unwrap();
    let (seg_txs, seg_finals) = r.archive(seg_from, &program);
    let prov = format!(
        "{prov_common}; the declared economy patch (the wide province's resolved_next = the current bell, standing in for the unmodelled WideResolve; player 0's wide holding's stores filled and 40 Spearmen in reserve) and the witnessed segment (wide economy, garrison, a pending slot-3 filing, EndSeason, the WideCloses 72 h after the end); steps: {}",
        r.log.join("; ")
    );
    let segment = input_of(
        program,
        so_hash,
        seg_txs,
        seg_finals,
        r.c.slot(),
        prov.clone(),
        "playable-next-segment",
    );
    let snap = input_of(
        program,
        so_hash,
        vec![],
        snapshot,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the segment names, read before its first use; {prov}"),
        "playable-next-snapshot",
    );
    let found = vwl::judge_segment(&segment, &snap.finals);
    for f in &found {
        println!(
            "segment {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    for l in &r.log {
        println!("{l}");
    }
    // The whole archive from genesis (the patches showing as state no
    // instruction wrote), for the season-mode wiring test.
    let (all_txs, all_finals) = r.archive(0, &program);
    let whole = input_of(
        program,
        so_hash,
        all_txs,
        all_finals,
        r.c.slot(),
        format!("the whole archive from AnnounceSeason on, the three declared patches showing as state the archive never saw an instruction write; {prov}"),
        "playable-next-whole",
    );
    if let Ok(dir) = std::env::var("PLAYABLE_WIDE_DUMP") {
        let d = std::path::Path::new(&dir);
        whole
            .save(&d.join("playable-next-whole.json.gz"))
            .expect("save");
        natural
            .save(&d.join("playable-next-setrules.json.gz"))
            .expect("save");
        seg_a
            .save(&d.join("playable-next-claims-segment.json.gz"))
            .expect("save");
        snap_a
            .save(&d.join("playable-next-claims-snapshot.json.gz"))
            .expect("save");
        segment
            .save(&d.join("playable-next-segment.json.gz"))
            .expect("save");
        snap.save(&d.join("playable-next-snapshot.json.gz"))
            .expect("save");
        println!("saved to {dir}");
    }
    assert_eq!(
        rep.verdict,
        verify_core::Verdict::Pass,
        "the natural placement-2 season with WideSetRules"
    );
    assert!(found_a.is_empty(), "the honest claims segment");
    assert!(found.is_empty(), "the honest segment");
}

fn player_metas(a: &Addresses, m: &Member) -> Vec<AccountMeta> {
    let w = m.wallet.pubkey();
    vec![
        AccountMeta::new_readonly(w, true),
        AccountMeta::new(w, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(m.citizen), false),
    ]
}

/// 0xDA op 3 WideEconomy for `m` over its wide holding at `(coord, site)`.
fn economy_ix(
    a: &Addresses,
    m: &Member,
    coord: WideCoord,
    site: u8,
    action: Action,
) -> Instruction {
    let c = ctx_of(a);
    let mut accounts = player_metas(a, m);
    accounts.push(AccountMeta::new(
        adr(wh::holding_address(&c, coord, site)),
        false,
    ));
    let prov = adr(wl::province_address(&c, coord));
    accounts.push(if action.mirror_write() {
        AccountMeta::new(prov, false)
    } else {
        AccountMeta::new_readonly(prov, false)
    });
    wide_ix(
        a,
        accounts,
        wix::Economy { action }.to_bytes().expect("action").to_vec(),
    )
}

/// 0xDA op 4 WideGarrison(+delta).
fn garrison_ix(a: &Addresses, m: &Member, coord: WideCoord, site: u8, delta: i64) -> Instruction {
    let c = ctx_of(a);
    let mut accounts = player_metas(a, m);
    accounts.push(AccountMeta::new(
        adr(wh::holding_address(&c, coord, site)),
        false,
    ));
    accounts.push(AccountMeta::new(
        adr(wl::province_address(&c, coord)),
        false,
    ));
    wide_ix(
        a,
        accounts,
        wix::Garrison { delta }.to_bytes().expect("delta").to_vec(),
    )
}

/// 0xDE WideClose(0): a ticket record; `funder` exactly when its escrow is
/// non-zero.
fn close_ticket_ix(
    a: &Addresses,
    any: &Address,
    citizen: [u8; 32],
    rent_payer: Address,
    funder: Option<Address>,
) -> Instruction {
    let c = ctx_of(a);
    let mut accounts = vec![
        AccountMeta::new_readonly(*any, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(citizen), false),
        AccountMeta::new(adr(wt::ticket_address(&c, &citizen)), false),
        AccountMeta::new(rent_payer, false),
    ];
    if let Some(f) = funder {
        accounts.push(AccountMeta::new(f, false));
    }
    wide_ix(
        a,
        accounts,
        wix::Close {
            what: wix::CLOSE_WHAT_TICKET,
        }
        .to_bytes()
        .to_vec(),
    )
}

/// 0xDE WideClose(1): a wide holding.
fn close_holding_ix(
    a: &Addresses,
    any: &Address,
    coord: WideCoord,
    site: u8,
    rent_payer: Address,
) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new_readonly(*any, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wh::holding_address(&c, coord, site)), false),
            AccountMeta::new(rent_payer, false),
            AccountMeta::new(a.defence_pool(), false),
        ],
        wix::Close {
            what: wix::CLOSE_WHAT_HOLDING,
        }
        .to_bytes()
        .to_vec(),
    )
}

/// 0xDE WideClose(6): a wide province, into its wedge's fund.
fn close_province_ix(a: &Addresses, any: &Address, coord: WideCoord) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new_readonly(*any, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::province_address(&c, coord)), false),
            AccountMeta::new(adr(c.province_fund(coord.wedge().expect("a wedge"))), false),
        ],
        wix::Close {
            what: wix::CLOSE_WHAT_PROVINCE,
        }
        .to_bytes()
        .to_vec(),
    )
}

// ------------------------------------------------------------ the committed recordings

fn natural() -> Input {
    common::fixture("playable-next-setrules.json.gz")
}

fn claims_segment() -> (Input, BTreeMap<[u8; 32], Option<Account>>) {
    (
        common::fixture("playable-next-claims-segment.json.gz"),
        common::fixture("playable-next-claims-snapshot.json.gz").finals,
    )
}

/// The data and account keys of the first program instruction of `t`.
fn first_ix(inp: &Input, t: usize) -> Option<(Vec<u8>, Vec<[u8; 32]>)> {
    let tx = fclient::tx::from_wire(&inp.txs[t].tx).ok()?;
    let keys = &tx.message.account_keys;
    let ci = tx
        .message
        .instructions
        .iter()
        .find(|c| keys[c.program_id_index as usize] == inp.cfg.program)?;
    Some((
        ci.data.clone(),
        ci.accounts
            .iter()
            .map(|&i| keys[i as usize].to_bytes())
            .collect(),
    ))
}

/// The transactions (successful or not, by `ok`) whose first program
/// instruction's data starts with `head`.
fn txs_like(inp: &Input, head: &[u8], ok: bool) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none() == ok
                && first_ix(inp, t).is_some_and(|(d, _)| d.starts_with(head))
        })
        .collect()
}

fn ix_key(inp: &Input, t: usize, n: usize) -> [u8; 32] {
    first_ix(inp, t).unwrap().1[n]
}

fn edit_post(inp: &mut Input, t: usize, k: &[u8; 32], f: impl FnOnce(&mut Account)) {
    let (_, a) = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x.to_bytes() == *k)
        .expect("a post-state");
    f(a.as_mut().expect("present"));
}

fn has(found: &[verify_core::Finding], code: &str) -> bool {
    found.iter().any(|f| f.check == "VWL" && f.code == code)
}

fn has_at(found: &[verify_core::Finding], code: &str, t: usize, needle: &str) -> bool {
    found.iter().any(|f| {
        f.check == "VWL"
            && f.code == code
            && f.entity == format!("tx#{t}")
            && f.detail.contains(needle)
    })
}

fn show(found: &[verify_core::Finding]) -> Vec<(String, String, String, String)> {
    found
        .iter()
        .map(|f| {
            (
                f.check.to_string(),
                f.code.clone(),
                f.entity.clone(),
                f.detail.clone(),
            )
        })
        .collect()
}

/// Whether the archive holds a post-state or final the program does not
/// own (a wallet): the unfiltered feed.
fn has_wallets(inp: &Input) -> bool {
    let wallet = |a: &Option<Account>| a.as_ref().is_some_and(|a| a.owner != inp.cfg.program);
    inp.txs
        .iter()
        .any(|t| t.post.iter().any(|(_, a)| wallet(a)))
        && inp.finals.values().any(wallet)
}

const T_RULES: u8 = wix::TAG_SET_RULES;
/// `tag ‖ config_version u16 ‖ keep_holder ‖ …` (`wix::SetRules`).
const RULES_KEEP_HOLDER_AT: usize = 3;

/// The Season's conquest-block `placement` byte.
fn placement_offset() -> usize {
    let a = params().to_bytes();
    let mut q = params();
    q.cq.placement = 0;
    let b = q.to_bytes();
    let at = (0..a.len()).find(|&i| a[i] != b[i]).expect("the byte");
    // The params sit in the Season at the conquest block's offset.
    let cq_at = a.len() - frontier_abi::v2::presets::CONQUEST_PARAMS_LEN;
    frontier_abi::v2::presets::SEASON_CQ_OFFSET + (at - cq_at)
}

// ---- 1. WideSetRules under placement 2 (D-verify-pr72-9)

#[test]
fn the_placement_2_season_with_wide_set_rules_passes() {
    let inp = natural();
    assert!(has_wallets(&inp), "the unfiltered feed");
    assert_eq!(txs_like(&inp, &[T_RULES], true).len(), 1);
    // Main's program refused the keep holder its placement forbids.
    let refused = txs_like(&inp, &[T_RULES], false);
    assert_eq!(refused.len(), 1);
    assert_eq!(
        first_ix(&inp, refused[0]).unwrap().0[RULES_KEEP_HOLDER_AT],
        KeepHolderRule::OrbitBalanced as u8
    );
    assert_eq!(inp.txs[refused[0]].code, Some(1), "BadData");
    let t = txs_like(&inp, &[T_RULES], true)[0];
    let sd = inp.txs[..t]
        .iter()
        .rev()
        .find_map(|x| {
            x.post
                .iter()
                .find(|(k, _)| k.to_bytes() == ix_key(&inp, t, 1))
                .and_then(|(_, a)| a.clone())
        })
        .expect("the Season before the rules");
    assert_eq!(sd.data[placement_offset()], PLACEMENT_MIXED);
    let rep = verify_core::verify(&inp);
    assert_eq!(
        rep.verdict,
        verify_core::Verdict::Pass,
        "{:#?}",
        show(&rep.findings)
    );
    assert!(rep.checks_run.contains(&"VWL:wide-land"));
}

/// The recorded rules with the keep holder swapped, in the instruction and
/// in the record it wrote: a self-consistent SetRules that only the
/// placement gate tells from the program's.
fn forbidden_rules(inp: &mut Input) -> usize {
    let t = txs_like(inp, &[T_RULES], true)[0];
    let k = ix_key(inp, t, 2);
    verify_core::tamper::edit_ix_tag(inp, t, T_RULES, |d| {
        d[RULES_KEEP_HOLDER_AT] = KeepHolderRule::OrbitBalanced as u8
    });
    edit_post(inp, t, &k, |a| {
        a.data[wr::rules_config::KEEP_HOLDER] = KeepHolderRule::OrbitBalanced as u8
    });
    // The final too, so the placement gate is the only thing that tells.
    inp.finals.get_mut(&k).unwrap().as_mut().unwrap().data[wr::rules_config::KEEP_HOLDER] =
        KeepHolderRule::OrbitBalanced as u8;
    t
}

#[test]
fn set_rules_with_a_keep_holder_the_placement_forbids_fails() {
    let mut inp = natural();
    let t = forbidden_rules(&mut inp);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, verify_core::Verdict::Fail);
    assert!(
        has_at(&rep.findings, "WideRule", t, "placement 2"),
        "{:#?}",
        show(&rep.findings)
    );
    // Not a byte mismatch: the record is the one the instruction names.
    assert!(!has(&rep.findings, "WideReplayMismatch"));
}

#[test]
fn the_refused_set_rules_presented_as_landed_fails() {
    // The transaction main's program refused, archived as a success with
    // the record it would have written.
    let mut inp = natural();
    let ok = txs_like(&inp, &[T_RULES], true)[0];
    let refused = txs_like(&inp, &[T_RULES], false)[0];
    let k = ix_key(&inp, ok, 2);
    let mut rec = inp.txs[ok]
        .post
        .iter()
        .find(|(x, _)| x.to_bytes() == k)
        .unwrap()
        .1
        .clone()
        .unwrap();
    rec.data[wr::rules_config::KEEP_HOLDER] = KeepHolderRule::OrbitBalanced as u8;
    inp.txs[refused].err = None;
    inp.txs[refused].code = None;
    inp.txs[refused].post.retain(|(x, _)| x.to_bytes() != k);
    inp.txs[refused]
        .post
        .push((Address::new_from_array(k), Some(rec)));
    let found = vwl::judge_segment(&inp, &BTreeMap::new());
    assert!(
        has_at(&found, "WideRule", refused, "placement 2"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn set_rules_with_an_unset_keep_holder_fails() {
    let mut inp = natural();
    let t = txs_like(&inp, &[T_RULES], true)[0];
    let k = ix_key(&inp, t, 2);
    verify_core::tamper::edit_ix_tag(&mut inp, t, T_RULES, |d| d[RULES_KEEP_HOLDER_AT] = 0);
    edit_post(&mut inp, t, &k, |a| {
        a.data[wr::rules_config::KEEP_HOLDER] = 0
    });
    let found = vwl::judge_segment(&inp, &BTreeMap::new());
    assert!(
        has_at(&found, "WideRule", t, "keep-holder"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn the_gate_is_the_placements_and_other_placements_keep_every_candidate() {
    // The same swapped rules under a Season whose placement is not 2: the
    // program takes them (`keep_holder_allowed`), and so does VWL.
    let mut inp = natural();
    let t = forbidden_rules(&mut inp);
    let season = ix_key(&inp, t, 1);
    let at = placement_offset();
    for u in 0..t {
        if let Some((_, Some(a))) = inp.txs[u]
            .post
            .iter_mut()
            .find(|(x, _)| x.to_bytes() == season)
        {
            if a.data.len() > at {
                a.data[at] = 1;
            }
        }
    }
    let found = vwl::judge_segment(&inp, &BTreeMap::new());
    assert!(
        !found.iter().any(|f| f.entity == format!("tx#{t}")),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_forged_rules_record_under_placement_2_fails() {
    let mut inp = natural();
    let t = txs_like(&inp, &[T_RULES], true)[0];
    let k = ix_key(&inp, t, 2);
    edit_post(&mut inp, t, &k, |a| {
        a.data[wr::rules_config::KEEP_HOLDER] = KeepHolderRule::OrbitBalanced as u8
    });
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, verify_core::Verdict::Fail);
    assert!(has_at(&rep.findings, "WideReplayMismatch", t, ""));
}

// ---- the claims of main's build, from the unfiltered feed (D-verify-pr72-10)

#[test]
fn the_honest_claims_of_mains_build_re_run_from_the_unfiltered_feed() {
    let (seg, snap) = claims_segment();
    assert!(has_wallets(&seg), "the unfiltered feed");
    assert!(
        snap.values()
            .any(|a| a.as_ref().is_some_and(|a| a.owner != seg.cfg.program)),
        "the witness holds wallets"
    );
    assert_eq!(txs_like(&seg, &[wix::TAG_CLAIM_SITE], true).len(), 3);
    assert_eq!(txs_like(&seg, &[wix::TAG_SETTLE_TICKET], true).len(), 3);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}

#[test]
fn a_drained_claim_in_the_unfiltered_feed_fails() {
    let (mut seg, snap) = claims_segment();
    let t = txs_like(&seg, &[wix::TAG_CLAIM_SITE], true)[0];
    let anchor = ix_key(&seg, t, 7);
    edit_post(&mut seg, t, &anchor, |a| a.lamports -= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "lost"),
        "{:#?}",
        show(&found)
    );
}

// ---- 2. the season-end WideClose (ticket, holding, province)

type Snap = BTreeMap<[u8; 32], Option<Account>>;

fn segment() -> (Input, Snap) {
    (
        common::fixture("playable-next-segment.json.gz"),
        common::fixture("playable-next-snapshot.json.gz").finals,
    )
}

fn close_head(what: u8) -> [u8; 2] {
    wix::Close { what }.to_bytes()
}

/// The successful closes of the recording: tickets `[pending, Settled
/// with its escrow, Settled without]`, holdings, provinces.
fn closes(inp: &Input) -> (Vec<usize>, Vec<usize>, Vec<usize>) {
    (
        txs_like(inp, &close_head(wix::CLOSE_WHAT_TICKET), true),
        txs_like(inp, &close_head(wix::CLOSE_WHAT_HOLDING), true),
        txs_like(inp, &close_head(wix::CLOSE_WHAT_PROVINCE), true),
    )
}

/// Edits the state of `k` that transaction `t` runs from: its latest
/// post-state before `t`, else the witness.
fn edit_before(
    inp: &mut Input,
    snap: &mut Snap,
    t: usize,
    k: &[u8; 32],
    f: impl FnOnce(&mut Account),
) {
    for u in (0..t).rev() {
        if inp.txs[u].err.is_some() {
            continue;
        }
        if let Some((_, a)) = inp.txs[u].post.iter_mut().find(|(x, _)| x.to_bytes() == *k) {
            return f(a.as_mut().expect("present before"));
        }
    }
    f(snap
        .get_mut(k)
        .expect("in the witness")
        .as_mut()
        .expect("present before"))
}

fn state_before(inp: &Input, snap: &Snap, t: usize, k: &[u8; 32]) -> Account {
    for u in (0..t).rev() {
        if inp.txs[u].err.is_some() {
            continue;
        }
        if let Some((_, a)) = inp.txs[u].post.iter().find(|(x, _)| x.to_bytes() == *k) {
            return a.clone().expect("present before");
        }
    }
    snap.get(k).cloned().flatten().expect("in the witness")
}

/// Puts the closed account `k` back into `t`'s post-states as `a`.
fn unclose(inp: &mut Input, t: usize, k: &[u8; 32], a: Account) {
    let slot = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x.to_bytes() == *k)
        .expect("a post-state");
    assert!(slot.1.is_none(), "the recording closed it");
    slot.1 = Some(a);
}

fn only_missing(found: &[verify_core::Finding], t: usize) -> bool {
    let at: Vec<_> = found
        .iter()
        .filter(|f| f.entity == format!("tx#{t}"))
        .collect();
    !at.is_empty() && at.iter().all(|f| f.code == "MissingData")
}

#[test]
fn the_honest_season_end_closes_re_run() {
    let (seg, snap) = segment();
    assert!(has_wallets(&seg), "the unfiltered feed");
    let (tickets, holdings, provinces) = closes(&seg);
    assert_eq!((tickets.len(), holdings.len(), provinces.len()), (3, 2, 2));
    // The three ticket shapes: pending with its funder, Settled with its
    // escrow and funder, Settled without an escrow or a funder.
    let n = |t: usize| first_ix(&seg, t).unwrap().1.len();
    assert_eq!((n(tickets[0]), n(tickets[1]), n(tickets[2])), (6, 6, 5));
    let status = |t: usize| {
        let k = ix_key(&seg, t, 3);
        frontier_abi::world_index::ticket::WideTicket::read(&state_before(&seg, &snap, t, &k).data)
            .unwrap()
            .status
    };
    use frontier_abi::world_index::ticket::TicketStatus;
    assert_eq!(status(tickets[0]), TicketStatus::Open);
    assert_eq!(status(tickets[1]), TicketStatus::Settled);
    assert_eq!(status(tickets[2]), TicketStatus::Settled);
    // Every closed account is absent after its close.
    for (t, at) in tickets
        .iter()
        .map(|t| (*t, 3))
        .chain(holdings.iter().map(|t| (*t, 2)))
        .chain(provinces.iter().map(|t| (*t, 2)))
    {
        let k = ix_key(&seg, t, at);
        let post = seg.txs[t].post.iter().find(|(x, _)| x.to_bytes() == k);
        assert!(matches!(post, Some((_, None))), "tx {t}");
    }
    // The refusals the program itself made are archived, not judged: a
    // close while Running, before end + 72 h, with a funder but no escrow,
    // of a record already closed.
    assert_eq!(txs_like(&seg, &[wix::TAG_CLOSE], false).len(), 4);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}

#[test]
fn the_march_record_closes_stay_unmodelled() {
    for what in 0..=wix::CLOSE_WHAT_MAX {
        let judged = vwl::judged(&close_head(what)).is_some();
        assert_eq!(
            judged,
            matches!(
                what,
                wix::CLOSE_WHAT_TICKET | wix::CLOSE_WHAT_HOLDING | wix::CLOSE_WHAT_PROVINCE
            ),
            "what {what}"
        );
    }
}

#[test]
fn a_ticket_record_that_was_not_closed_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).0[1];
    let k = ix_key(&seg, t, 3);
    let mut left = state_before(&seg, &snap, t, &k);
    left.lamports = 1;
    unclose(&mut seg, t, &k, left);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "was not closed"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_pending_close_that_keeps_the_citizens_marker_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).0[0];
    let citizen = ix_key(&seg, t, 2);
    let before = state_before(&seg, &snap, t, &citizen);
    edit_post(&mut seg, t, &citizen, |a| a.data = before.data.clone());
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "the Citizen"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_settled_close_that_writes_the_citizen_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).0[1];
    let citizen = ix_key(&seg, t, 2);
    edit_post(&mut seg, t, &citizen, |a| {
        a.data[frontier_abi::layout::player::citizen::FLAGS] ^= 0x40
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "never writes"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_close_before_the_seasons_end_plus_72_hours_fails() {
    let (seg0, snap) = segment();
    let (tickets, holdings, provinces) = closes(&seg0);
    let end =
        seg0.txs[txs_like(&seg0, &[frontier_abi::tags::Ix::EndSeason.tag()], true)[0]].block_time;
    for t in [tickets[0], holdings[0], provinces[0]] {
        let mut seg = seg0.clone();
        // A bell after EndSeason: Ended, and far from end + 72 h.
        seg.txs[t].block_time = end + 600;
        let found = vwl::judge_segment(&seg, &snap);
        assert!(
            has_at(&found, "WideRule", t, "TooEarly"),
            "{:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_close_in_a_season_that_never_ended_fails() {
    let (mut seg, snap) = segment();
    let (tickets, holdings, provinces) = closes(&seg);
    let end = txs_like(&seg, &[frontier_abi::tags::Ix::EndSeason.tag()], true)[0];
    let season = ix_key(&seg, end, 1);
    edit_post(&mut seg, end, &season, |a| {
        a.data[S::STATUS] = S::STATUS_RUNNING
    });
    let found = vwl::judge_segment(&seg, &snap);
    for t in [tickets[0], holdings[0], provinces[0]] {
        assert!(
            has_at(&found, "WideAccounts", t, "Season"),
            "{:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_close_to_a_rent_payer_that_is_not_the_records_fails() {
    let (seg0, snap0) = segment();
    let (tickets, holdings, _) = closes(&seg0);
    // The ticket's immutable rent payer; the holding's.
    use frontier_abi::world_index::ticket::wide_ticket as WTL;
    for (t, at, off) in [
        (tickets[1], 3, WTL::RENT_PAYER),
        (holdings[0], 2, H::RENT_PAYER),
    ] {
        let (mut seg, mut snap) = (seg0.clone(), snap0.clone());
        let k = ix_key(&seg, t, at);
        edit_before(&mut seg, &mut snap, t, &k, |a| a.data[off] ^= 1);
        let found = vwl::judge_segment(&seg, &snap);
        assert!(
            has_at(&found, "WideAccounts", t, "rent payer"),
            "tx {t}: {:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_ticket_close_whose_funder_is_not_the_records_fails() {
    let (mut seg, mut snap) = segment();
    let t = closes(&seg).0[1];
    let k = ix_key(&seg, t, 3);
    use frontier_abi::world_index::ticket::wide_ticket as WTL;
    edit_before(&mut seg, &mut snap, t, &k, |a| a.data[WTL::FUNDER] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideAccounts", t, "funder"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_ticket_close_without_the_funder_of_its_escrow_fails() {
    // The Settled record without an escrow, given one: the funder must
    // then be listed, and the recorded close lists none.
    let (mut seg, mut snap) = segment();
    let t = closes(&seg).0[2];
    let k = ix_key(&seg, t, 3);
    use frontier_abi::world_index::ticket::wide_ticket as WTL;
    let rent_w = {
        let u = closes(&seg).0[1];
        let ku = ix_key(&seg, u, 3);
        frontier_abi::world_index::ticket::WideTicket::read(&state_before(&seg, &snap, u, &ku).data)
            .unwrap()
            .escrow
    };
    edit_before(&mut seg, &mut snap, t, &k, |a| {
        a.data[WTL::ESCROW..WTL::ESCROW + 8].copy_from_slice(&rent_w.to_le_bytes());
        a.lamports += rent_w;
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "Undecodable", t, "funder"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn an_open_record_closed_beside_a_citizen_without_its_marker_fails() {
    let (mut seg, mut snap) = segment();
    let t = closes(&seg).0[0];
    let citizen = ix_key(&seg, t, 2);
    let cleared = seg.txs[t]
        .post
        .iter()
        .find(|(x, _)| x.to_bytes() == citizen)
        .unwrap()
        .1
        .clone()
        .unwrap();
    edit_before(&mut seg, &mut snap, t, &citizen, |a| {
        a.data = cleared.data.clone()
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideAccounts", t, "do not pair"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_holding_close_that_skips_the_pool_owed_sweep_fails() {
    let (mut seg, mut snap) = segment();
    let t = closes(&seg).1[0];
    let k = ix_key(&seg, t, 2);
    edit_before(&mut seg, &mut snap, t, &k, |a| {
        a.data[H::POOL_OWED..H::POOL_OWED + 8].copy_from_slice(&7_000u64.to_le_bytes());
        a.lamports += 7_000;
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "DefencePool"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_holding_close_that_drains_or_rewrites_the_defence_pool_fails() {
    let (seg0, snap) = segment();
    let t = closes(&seg0).1[1];
    let dpool = ix_key(&seg0, t, 4);
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &dpool, |a| a.lamports -= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "DefencePool"),
        "{:#?}",
        show(&found)
    );
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &dpool, |a| a.data[40] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "DefencePool"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_holding_that_was_not_closed_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).1[0];
    let k = ix_key(&seg, t, 2);
    let left = state_before(&seg, &snap, t, &k);
    unclose(&mut seg, t, &k, left);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "was not closed"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_holding_close_at_another_address_fails() {
    let (mut seg, mut snap) = segment();
    let t = closes(&seg).1[0];
    let k = ix_key(&seg, t, 2);
    // The identity trailer's site: the record is then another site's.
    edit_before(&mut seg, &mut snap, t, &k, |a| a.data[H::SITE] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        found
            .iter()
            .any(|f| f.entity == format!("tx#{t}") && f.severity == verify_core::Severity::Fail),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_province_close_that_shorts_or_miscounts_the_fund_fails() {
    let (seg0, snap) = segment();
    let t = closes(&seg0).2[0];
    let fund = ix_key(&seg0, t, 3);
    use frontier_abi::layout::world::province_fund as PF;
    // The province's lamports did not all reach the fund.
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &fund, |a| a.lamports -= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "wedge fund"),
        "{:#?}",
        show(&found)
    );
    // provinces_opened did not step.
    let before = state_before(&seg0, &snap, t, &fund);
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &fund, |a| {
        a.data[PF::PROVINCES_OPENED..PF::PROVINCES_OPENED + 4]
            .copy_from_slice(&before.data[PF::PROVINCES_OPENED..PF::PROVINCES_OPENED + 4])
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "wedge fund"),
        "{:#?}",
        show(&found)
    );
    // A lifetime counter moved.
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &fund, |a| a.data[PF::SPENT_TOTAL] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "wedge fund"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_province_that_was_not_closed_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).2[1];
    let k = ix_key(&seg, t, 2);
    let left = state_before(&seg, &snap, t, &k);
    unclose(&mut seg, t, &k, left);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "was not closed"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_gift_into_a_closing_fund_or_pool_is_unverifiable_not_a_pass() {
    let (seg0, snap) = segment();
    let (_, holdings, provinces) = closes(&seg0);
    for (t, at) in [(holdings[0], 4), (provinces[0], 3)] {
        let mut seg = seg0.clone();
        let k = ix_key(&seg, t, at);
        edit_post(&mut seg, t, &k, |a| a.lamports += 1);
        let found = vwl::judge_segment(&seg, &snap);
        assert!(only_missing(&found, t), "tx {t}: {:#?}", show(&found));
    }
}

#[test]
fn a_close_over_the_tombstone_is_unverifiable_and_a_province_close_fails() {
    let (mut seg, snap) = segment();
    let (tickets, holdings, provinces) = closes(&seg);
    let end = txs_like(&seg, &[frontier_abi::tags::Ix::EndSeason.tag()], true)[0];
    let season = ix_key(&seg, end, 1);
    edit_post(&mut seg, end, &season, |a| {
        a.data.truncate(S::TOMBSTONE_SIZE)
    });
    let found = vwl::judge_segment(&seg, &snap);
    for t in [tickets[0], holdings[0]] {
        assert!(only_missing(&found, t), "tx {t}: {:#?}", show(&found));
    }
    assert!(
        has_at(&found, "WideAccounts", provinces[0], "Season"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_close_of_an_account_the_witness_does_not_show_is_unverifiable() {
    let (seg, mut snap) = segment();
    let t = closes(&seg).0[1];
    let k = ix_key(&seg, t, 3);
    snap.remove(&k);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(only_missing(&found, t), "{:#?}", show(&found));
}

#[test]
fn a_close_that_also_writes_another_program_account_fails() {
    let (mut seg, snap) = segment();
    let t = closes(&seg).0[2];
    // A Settled close beside a present Citizen writes nothing of it; here
    // an unlisted program account changes too.
    let other = ix_key(&seg, closes(&seg).2[0], 3);
    let mut a = state_before(&seg, &snap, t, &other);
    a.data[40] ^= 1;
    seg.txs[t]
        .post
        .push((Address::new_from_array(other), Some(a)));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "does not list"),
        "{:#?}",
        show(&found)
    );
}

/// The whole archive in season mode: V0 leaves the closes to VWL, and no
/// check FAILs an honest close (the declared patches break the season
/// elsewhere, as in `playable_wide_claims.rs`).
#[test]
fn season_mode_judges_the_closes() {
    let inp = common::fixture("playable-next-whole.json.gz");
    let (tickets, holdings, provinces) = closes(&inp);
    assert_eq!((tickets.len(), holdings.len(), provinces.len()), (3, 2, 2));
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, verify_core::Verdict::Pass, "the patches");
    let sigs: Vec<String> = tickets
        .iter()
        .chain(&holdings)
        .chain(&provinces)
        .map(|&t| inp.txs[t].signature.to_string())
        .collect();
    let at_close: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| sigs.contains(&f.signature))
        .collect();
    assert!(
        at_close.is_empty(),
        "{:#?}",
        at_close
            .iter()
            .map(|f| (f.check, &f.code, &f.entity, &f.detail))
            .collect::<Vec<_>>()
    );
    // And a tampered close FAILs in season mode too.
    let mut bad = inp.clone();
    let t = provinces[0];
    let fund = ix_key(&bad, t, 3);
    edit_post(&mut bad, t, &fund, |a| a.lamports -= 1);
    let rep = verify_core::verify(&bad);
    assert!(
        has_at(&rep.findings, "WideReplayMismatch", t, "wedge fund"),
        "{:#?}",
        show(&rep.findings)
    );
}

// ---- 3. the wide economy and garrison

/// `tag ‖ escape ‖ version ‖ op` (the wide envelope).
fn economy_head() -> [u8; 4] {
    let b = wix::Economy {
        action: Action::Harvest,
    }
    .to_bytes()
    .unwrap();
    [b[0], b[1], b[2], b[3]]
}

fn garrison_head() -> [u8; 4] {
    let b = wix::Garrison { delta: 1 }.to_bytes().unwrap();
    [b[0], b[1], b[2], b[3]]
}

/// The successful economy actions and garrisons of the recording.
fn actions(inp: &Input) -> (Vec<usize>, Vec<usize>) {
    (
        txs_like(inp, &economy_head(), true),
        txs_like(inp, &garrison_head(), true),
    )
}

fn action_of(inp: &Input, t: usize) -> Action {
    wix::Economy::decode(&first_ix(inp, t).unwrap().0)
        .unwrap()
        .action
}

fn post_data(inp: &Input, t: usize, k: &[u8; 32]) -> Vec<u8> {
    inp.txs[t]
        .post
        .iter()
        .find(|(x, _)| x.to_bytes() == *k)
        .and_then(|(_, a)| a.clone())
        .expect("a post-state")
        .data
}

fn any_fail_at(found: &[verify_core::Finding], t: usize) -> bool {
    found.iter().any(|f| {
        f.check == "VWL"
            && f.entity == format!("tx#{t}")
            && f.severity == verify_core::Severity::Fail
    })
}

#[test]
fn the_honest_wide_economy_and_garrison_re_run() {
    let (seg, snap) = segment();
    let (eco, gar) = actions(&seg);
    let got: Vec<Action> = eco.iter().map(|&t| action_of(&seg, t)).collect();
    assert_eq!(
        got,
        vec![
            Action::Harvest,
            Action::Build { item: 0 },
            Action::Build { item: 6 },
            Action::Train { unit: 0, n: 5 },
            Action::Harvest,
            Action::Harvest,
        ],
        "Harvest, a building, the walls (a mirror write), a training, and a second owner's Harvest"
    );
    assert_eq!(gar.len(), 2);
    // The first Harvest flips its provisional holding final (lazy finality).
    let h = ix_key(&seg, eco[0], 4);
    assert_eq!(
        state_before(&seg, &snap, eco[0], &h).data[H::STATE],
        H::STATE_PROVISIONAL
    );
    assert_eq!(post_data(&seg, eco[0], &h)[H::STATE], H::STATE_FINAL);
    // The walls wrote the province's mirror; a Harvest lists it read-only.
    let p = ix_key(&seg, eco[2], 5);
    assert_ne!(
        post_data(&seg, eco[2], &p),
        state_before(&seg, &snap, eco[2], &p).data
    );
    assert!(!seg.txs[eco[0]].post.iter().any(|(x, _)| x.to_bytes() == p));
    // The program's own refusals are archived, not judged: the tier-up of
    // a Hamlet, another Citizen's holding, a garrison above the reserve.
    assert_eq!(txs_like(&seg, &economy_head(), false).len(), 2);
    assert_eq!(txs_like(&seg, &garrison_head(), false).len(), 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}

#[test]
fn a_forged_store_after_a_wide_economy_action_fails() {
    let (seg0, snap) = segment();
    let (eco, _) = actions(&seg0);
    for &t in &eco {
        let mut seg = seg0.clone();
        let h = ix_key(&seg, t, 4);
        edit_post(&mut seg, t, &h, |a| a.data[H::store(1) + AC::VALUE] ^= 1);
        let found = vwl::judge_segment(&seg, &snap);
        assert!(
            has_at(&found, "WideReplayMismatch", t, "holding"),
            "tx {t}: {:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_training_that_gave_more_troops_than_it_paid_for_fails() {
    let (mut seg, snap) = segment();
    let (eco, _) = actions(&seg);
    let t = eco[3];
    let h = ix_key(&seg, t, 4);
    edit_post(&mut seg, t, &h, |a| a.data[H::reserve(0)] += 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "holding"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_wide_economy_action_on_a_holding_of_another_citizen_fails() {
    let (mut seg, mut snap) = segment();
    let (eco, _) = actions(&seg);
    let t = eco[0];
    let h = ix_key(&seg, t, 4);
    edit_before(&mut seg, &mut snap, t, &h, |a| {
        a.data[H::OWNER_CITIZEN] ^= 1
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideRule", t, "NotOwner"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_wide_economy_action_by_someone_who_is_not_the_citizens_wallet_fails() {
    let (mut seg, mut snap) = segment();
    let (eco, gar) = actions(&seg);
    let citizen = ix_key(&seg, eco[0], 3);
    edit_before(&mut seg, &mut snap, eco[0], &citizen, |a| {
        a.data[frontier_abi::layout::player::citizen::WALLET] ^= 1
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideAccounts", eco[0], "player prologue"),
        "{:#?}",
        show(&found)
    );
    let _ = gar;
}

#[test]
fn a_record_that_is_not_the_instructions_action_fails() {
    // The instruction says Build, the record (and the state) say Harvest.
    let (mut seg, snap) = segment();
    let (eco, _) = actions(&seg);
    let t = eco[0];
    verify_core::tamper::edit_ix_tag(&mut seg, t, wix::TAG_DEPART, |d| {
        *d = wix::Economy {
            action: Action::Build { item: 1 },
        }
        .to_bytes()
        .unwrap()
        .to_vec()
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "not the instruction's"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_record_of_another_time_than_the_transactions_fails() {
    let (mut seg, snap) = segment();
    let (eco, gar) = actions(&seg);
    seg.txs[eco[1]].block_time += 1;
    seg.txs[gar[0]].block_time += 1;
    let found = vwl::judge_segment(&seg, &snap);
    for t in [eco[1], gar[0]] {
        assert!(
            has_at(&found, "WideReplayMismatch", t, "now_ts"),
            "tx {t}: {:#?}",
            show(&found)
        );
    }
}

#[test]
fn an_action_whose_record_is_not_in_the_logs_is_unverifiable() {
    let (mut seg, snap) = segment();
    let (eco, gar) = actions(&seg);
    for t in [eco[0], gar[0]] {
        seg.txs[t].logs.retain(|l| !l.starts_with("Program data:"));
    }
    let found = vwl::judge_segment(&seg, &snap);
    for t in [eco[0], gar[0]] {
        assert!(only_missing(&found, t), "tx {t}: {:#?}", show(&found));
    }
}

#[test]
fn an_action_that_drains_its_accounts_fails() {
    let (seg0, snap) = segment();
    let (eco, gar) = actions(&seg0);
    for (t, at) in [
        (eco[0], 3),
        (eco[1], 4),
        (eco[2], 5),
        (gar[0], 5),
        (gar[1], 4),
    ] {
        let mut seg = seg0.clone();
        let k = ix_key(&seg, t, at);
        edit_post(&mut seg, t, &k, |a| a.lamports -= 1);
        let found = vwl::judge_segment(&seg, &snap);
        assert!(
            has_at(&found, "WideReplayMismatch", t, "lost"),
            "tx {t}: {:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_forged_wall_mirror_fails() {
    let (mut seg, snap) = segment();
    let (eco, _) = actions(&seg);
    let t = eco[2];
    assert!(action_of(&seg, t).mirror_write());
    let (h, p) = (ix_key(&seg, t, 4), ix_key(&seg, t, 5));
    let site = state_before(&seg, &snap, t, &h).data[H::SITE] as usize;
    let before = state_before(&seg, &snap, t, &p).data;
    let after = post_data(&seg, t, &p);
    let o = PV::site(site);
    let at = (o..o + SM::SIZE)
        .find(|&i| before[i] != after[i])
        .expect("the walls wrote the site mirror");
    edit_post(&mut seg, t, &p, |a| a.data[at] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "province"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_forged_garrison_fails() {
    let (seg0, snap) = segment();
    let (_, gar) = actions(&seg0);
    let t = gar[0];
    let (h, p) = (ix_key(&seg0, t, 4), ix_key(&seg0, t, 5));
    let site = state_before(&seg0, &snap, t, &h).data[H::SITE] as usize;
    // More troops pending than the reserve gave.
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &p, |a| {
        a.data[PV::site(site) + SM::PEND0_DELTA] ^= 1
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "province"),
        "{:#?}",
        show(&found)
    );
    // The reserve was not debited.
    let before = state_before(&seg0, &snap, t, &h).data;
    let mut seg = seg0.clone();
    edit_post(&mut seg, t, &h, |a| {
        let o = H::reserve(0);
        a.data[o..o + 4].copy_from_slice(&before[o..o + 4])
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "holding"),
        "{:#?}",
        show(&found)
    );
    // The instruction's delta is not the record's.
    let mut seg = seg0.clone();
    verify_core::tamper::edit_ix_tag(&mut seg, t, wix::TAG_DEPART, |d| {
        *d = wix::Garrison { delta: 8 }.to_bytes().unwrap().to_vec()
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        has_at(&found, "WideReplayMismatch", t, "delta"),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_garrison_in_a_province_that_is_not_resolved_fails() {
    // The province two bells behind: the program refuses NotResident. The
    // receipt no longer commits to this pre-state, so the re-run refuses.
    let (mut seg, mut snap) = segment();
    let (_, gar) = actions(&seg);
    let t = gar[0];
    let p = ix_key(&seg, t, 5);
    edit_before(&mut seg, &mut snap, t, &p, |a| {
        a.data[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&0u32.to_le_bytes())
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(any_fail_at(&found, t), "{:#?}", show(&found));
}

#[test]
fn an_action_that_writes_an_account_it_does_not_list_fails() {
    let (mut seg, snap) = segment();
    let (eco, _) = actions(&seg);
    let t = eco[4];
    // A Harvest lists its province read-only; here the province changes.
    let p = ix_key(&seg, t, 5);
    let mut a = state_before(&seg, &snap, t, &p);
    a.data[PV::RESOLVED_NEXT] ^= 1;
    seg.txs[t].post.push((Address::new_from_array(p), Some(a)));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(any_fail_at(&found, t), "{:#?}", show(&found));
}

/// Season mode: V0 leaves the economy and the garrison to VWL, and a wide
/// record in a transaction's logs no longer fails the PS2 checks (CQ1, V1).
/// In this archive the economy runs after the declared patch 3, which the
/// archive never saw an instruction write, so VWL's findings there are the
/// patch showing.
#[test]
fn season_mode_judges_the_economy_and_wide_records_do_not_fail_the_ps2_checks() {
    let inp = common::fixture("playable-next-whole.json.gz");
    let (eco, gar) = actions(&inp);
    assert_eq!((eco.len(), gar.len()), (6, 2));
    let rep = verify_core::verify(&inp);
    let sigs: Vec<String> = eco
        .iter()
        .chain(&gar)
        .chain(&closes(&inp).2)
        .map(|&t| inp.txs[t].signature.to_string())
        .collect();
    let others: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| sigs.contains(&f.signature) && f.check != "VWL")
        .map(|f| (f.check, f.code.clone(), f.detail.clone()))
        .collect();
    assert!(others.is_empty(), "{others:#?}");
    assert!(
        !rep.findings.iter().any(|f| f.code == "WideUnmodelled"),
        "every wide instruction and record of this archive is VWL's: {:#?}",
        show(&rep.findings)
    );
    assert!(!rep
        .findings
        .iter()
        .any(|f| f.detail.contains("UnsupportedWideRecord")));
    // The wide event chains (VW1) of the closed holdings and provinces end
    // where their closes left them: nothing unproven, nothing broken.
    assert!(
        !rep.findings.iter().any(|f| f.check == "VW1"),
        "{:#?}",
        show(&rep.findings)
    );
    // A terminal record that does not continue the province's chain is seen.
    let mut bad = inp.clone();
    let t = closes(&bad).2[0];
    let p = ix_key(&bad, t, 2);
    let before = (0..t)
        .rev()
        .find(|&u| {
            bad.txs[u].err.is_none()
                && bad.txs[u]
                    .post
                    .iter()
                    .any(|(x, a)| x.to_bytes() == p && a.is_some())
        })
        .unwrap();
    edit_post(&mut bad, before, &p, |a| {
        a.data[frontier_abi::layout::header::EVENT_HEAD] ^= 1
    });
    let rep = verify_core::verify(&bad);
    assert!(
        rep.findings.iter().any(|f| f.check == "VW1"),
        "{:#?}",
        show(&rep.findings)
    );
}
