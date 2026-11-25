//! VWL part 6: PLAYER TERRITORY (#209 territory-impl, #221's keeper
//! `territory` role) on the devnet `.so` that world 3 runs
//! (verifier-territory, 2026-11-25).
//!
//! One recording of the devnet-playable `.so` of upkeep-decay-prep (sha256
//! 245ce1ab…0d34, 3,517,568 B: Q-LP17-1 (b), NOT decided by r0ze, over
//! upkeep-x30's db85913c…9a5f, 3,517,472 B; that one over world 3's first `.so` 31acbb59 — the binary
//! the devnet upgrade of 2026-11-25 05:26 deployed — plus owner Q-VT-1 (b),
//! a captor's second conquest lands (conquest-upkeep-fix, 3d143093), and
//! Q-CUF-1 (b), land upkeep ×30 of the decided numbers (replacing the ×10
//! of Q-LP15-1 (b)); re-recorded, the shapes below unchanged) in
//! the in-process LiteSVM chain (`localnet::Chain`), made by
//! `record_playable_territory` (ignored; needs the artefact). The feed is
//! unfiltered (every writable account's post-state, wallets included) and
//! every `set_account` patch is DECLARED (`Input::declared`), so the whole
//! archive is judged from AnnounceSeason on in season mode.
//!
//! How the world gets there (the P18 rehearsal's shape, devnet-territory-dev,
//! without the page and the services):
//!
//! 1. A REAL world by its own instructions: `S1_DEVNET_TERRITORY` (the new
//!    devnet world's preset: continuous, no idle-home release) at program
//!    version 0x4804, three players of three nations (Join + PlaceHome), the
//!    authority's WideSetRules naming keep holder **NeutralTerritoryV1**.
//! 2. The wide land as `playable_wide_claims.rs` makes it (**declared**:
//!    RingSeed(128) + the Frontier's wedge counters; then REAL
//!    WideRequestRingSeed / WideConsumeRingSeed / WideOpenProvince of four
//!    ring-129 provinces, two of them at distance 2 from the rim home).
//! 3. **Declared**: the players' first homes moved to the rim (128, 0) as
//!    final Towns with stores (as `playable_wide_claims.rs`).
//! 4. REAL territory, the keeper's transactions in the keeper's shapes
//!    (`keeper::widelane::territory::{settle, decay, conquer, claim_tile}`,
//!    mirrored here byte for byte because verify's dev-dependency on
//!    `keeper` does not enable `playable-lane`): WideClaimTile by A, B (one
//!    a bell, a refused second claim in the same bell, a distance-2 claim,
//!    an own-land witness claim), WideClaimSite filed on A's own tile (the
//!    village rule T-6), keeper settles (paid; a second in the same second).
//! 5a. **Declared**: A's home makes 0.6 food/h net, store empty. REAL: the
//!    short settle that makes A unpaid, and the next turn's settle that
//!    takes the turn's food and leaves A unpaid (Q-LP17-1 (b)).
//! 5. **Declared** starvation of A's home (food 0, the kernel's maximum food
//!    upkeep: what P18 declares, VQ-1). REAL: the settle that makes A unpaid,
//!    a refused claim, 24 bells later settle + decay, the FARTHEST first,
//!    one a bell.
//! 6. **Declared** capture: the keep of B's province held by C's nation,
//!    captor C's rim home at a new keep generation (P18's declaration; the
//!    wide Resolve writes it on a real capture, `vwl_wide_march.rs`). REAL:
//!    settle B + conquer (C's summary created from the keeper's payer); a
//!    refused settle A + conquer two seconds later (the captor not settled
//!    in this second); then the keeper's shape settle A + settle C +
//!    conquer, which lands (Q-VT-1 (b); refused BadAccount on 31acbb59).
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/permutation_frontier.so PLAYABLE_WIDE_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_territory -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::ports::Account;
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::player::{accrual as AC, citizen as C, holding as H, holding_ref as HR};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::presets::{
    params_hash_v2, ConquestParams, SeasonParamsV2, S1_DEVNET_TERRITORY,
};
use frontier_abi::world_index::{
    land as wl,
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    territory::{self as wtr, TerritoryPlayer, TerritoryProvince},
    ticket as wt, wide_ix as wix, WideCoord,
};
use permutation_rules::frontier::beacon::{
    genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time, BeaconClock,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use verify_core::input::{Config, Declared, Input};
use verify_core::{Finding, Severity, Verdict};

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
/// The devnet-playable `.so` world 3 is to be created on: world 3's first
/// `.so` 31acbb59 (main `ca317418` … `ee081238`) + conquest-upkeep-fix
/// (Q-VT-1 (b) conquest flags) + upkeep-x30 (Q-CUF-1 (b) land upkeep ×30)
/// = db85913c, + upkeep-decay-prep (Q-LP17-1 (b), **NOT decided by r0ze**:
/// a short settle takes what the home holds and stays unpaid) = 245ce1ab.
const TERRITORY_SHA256: &str = "245ce1abcdb48d59aaec9e74eb571f5316e89302b02ae877bd3976b9245d0d34";
const SO_GZ: &str = "devnet-playable-245ce1ab.so.gz";
const WHOLE: &str = "playable-territory-whole.json.gz";
const RULES: wr::RuleBytes = wr::RuleBytes {
    keep_holder: KeepHolderRule::NeutralTerritoryV1 as u8,
    free_city: FreeCityRule::DeployedLe32V1 as u8,
    camp: CampRule::SortKeyDrawV1 as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
/// Ring 129: two at distance 1 from the rim home (128, 0), two at 2.
const OPENINGS: [(i64, i64); 4] = [(129, 0), (129, -1), (129, -2), (127, 2)];
const RIM: (i32, i32) = (128, 0);
const STORES: i64 = 5_000_000_000;

fn params() -> SeasonParamsV2 {
    let mut p = S1_DEVNET_TERRITORY;
    p.base.program_version = PROGRAM_VERSION;
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
    declared: Vec<Declared>,
    last_logs: Vec<String>,
}

impl Rec {
    fn feed_len(&self) -> usize {
        self.c.feed(0, usize::MAX, Some(&self.a.program)).len()
    }
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
    /// A declared `set_account` patch.
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
            .collect();
        let mut keys = std::collections::BTreeSet::new();
        for t in &txs {
            for (k, _) in &t.post {
                keys.insert(*k);
            }
            // (and every account a transaction names that the program owns
            //  at the end: VG's final-state check reads them all)
            if let Ok(m) = fclient::tx::from_wire(&t.tx) {
                for k in &m.message.account_keys {
                    if self.c.account(k).is_some_and(|a| a.owner == *program) {
                        keys.insert(*k);
                    }
                }
            }
        }
        let finals = keys
            .into_iter()
            .map(|k| {
                (
                    k.to_bytes(),
                    self.c
                        .account(&k)
                        .filter(|a| a.lamports > 0 || !a.data.is_empty()),
                )
            })
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

fn set_rules_ix(a: &Addresses, authority: &Address) -> Instruction {
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
            keep_holder: RULES.keep_holder,
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
    citizen: [u8; 32],
    rim_site: u8,
}

/// 0xD9 WideClaimSite (slot 2) for `m` at `(coord, site)`; in a territory
/// world the 13th account is the target's territory record.
fn claim_site_ix(a: &Addresses, m: &Member, coord: WideCoord, site: u8) -> Instruction {
    let c = ctx_of(a);
    let w = m.wallet.pubkey();
    let anchor = adr(c.holding(RIM.0, RIM.1, m.rim_site));
    let anchor_p = adr(c.province(RIM.0, RIM.1));
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
            AccountMeta::new(anchor, false),
            AccountMeta::new_readonly(anchor_p, false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
            AccountMeta::new_readonly(adr(wtr::province_address(&c, coord)), false),
        ],
        wix::ClaimSite {
            p: coord.p(),
            q: coord.q(),
            site,
            slot: 2,
        }
        .to_bytes()
        .to_vec(),
    )
}

// ---- the keeper's / the page's territory instructions
// (`keeper::widelane::territory`, byte for byte)

fn t_claim_tile(
    a: &Addresses,
    m: &Member,
    target: WideCoord,
    tile: u8,
    witness: Option<(u8, Address)>,
) -> Instruction {
    let c = ctx_of(a);
    let wallet = m.wallet.pubkey();
    let mut accounts = vec![
        AccountMeta::new_readonly(wallet, true),
        AccountMeta::new(wallet, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(m.citizen), false),
        AccountMeta::new_readonly(adr(wl::province_address(&c, target)), false),
        AccountMeta::new(adr(wtr::province_address(&c, target)), false),
        AccountMeta::new(adr(wtr::player_address(&c, &m.citizen)), false),
        AccountMeta::new(a.holding(RIM.0, RIM.1, m.rim_site), false),
        AccountMeta::new_readonly(a.province(RIM.0, RIM.1), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    let wbyte = witness.map_or(0, |(b, _)| b);
    if let Some((_, w)) = witness {
        accounts.push(AccountMeta::new_readonly(w, false));
    }
    wide_ix(
        a,
        accounts,
        wix::ClaimTile {
            p: target.p(),
            q: target.q(),
            tile,
            witness: wbyte,
            village: 0,
        }
        .to_bytes()
        .to_vec(),
    )
}

fn t_settle(a: &Addresses, payer: Address, citizen: &[u8; 32], home: Address) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wtr::player_address(&c, citizen)), false),
            AccountMeta::new(adr(*citizen), false),
            AccountMeta::new(home, false),
        ],
        wix::TerritorySettle.to_bytes().to_vec(),
    )
}

fn t_decay(
    a: &Addresses,
    payer: Address,
    citizen: &[u8; 32],
    province: WideCoord,
    tile: u8,
) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wtr::player_address(&c, citizen)), false),
            AccountMeta::new(adr(wtr::province_address(&c, province)), false),
        ],
        wix::TerritoryDecay { tile }.to_bytes().to_vec(),
    )
}

fn t_conquer(
    a: &Addresses,
    payer: Address,
    province: WideCoord,
    loser: &[u8; 32],
    captor_holding: Address,
    captor: &[u8; 32],
) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new_readonly(adr(wl::province_address(&c, province)), false),
            AccountMeta::new(adr(wtr::province_address(&c, province)), false),
            AccountMeta::new(adr(wtr::player_address(&c, loser)), false),
            AccountMeta::new_readonly(captor_holding, false),
            AccountMeta::new_readonly(adr(*captor), false),
            AccountMeta::new(adr(wtr::player_address(&c, captor)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::TerritoryConquer.to_bytes().to_vec(),
    )
}

fn input_of(
    program: Address,
    so_hash: [u8; 32],
    txs: Vec<fclient::ports::TxRecord>,
    finals: BTreeMap<[u8; 32], Option<Account>>,
    final_slot: u64,
    provenance: String,
    declared: Vec<Declared>,
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
        scenarios: vec!["playable-territory-whole".into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared,
        chain: Default::default(),
    }
}

/// The non-keep tiles of a wide province that no site stands on, and the
/// tiles of its free sites, from its bytes.
fn tiles_of(pd: &[u8]) -> (Vec<u8>, Vec<(u8, u8)>) {
    let keep = frontier_abi::conquest_model::read_keep(pd)
        .unwrap()
        .map_or(wl::NO_TILE, |k| k.tile);
    let n = pd[PV::SITE_COUNT] as usize;
    let site_tiles: Vec<u8> = (0..n).map(|j| pd[PV::SITES + j]).collect();
    let free: Vec<(u8, u8)> = (0..n)
        .filter(|&j| pd[PV::site(j) + SM::STATE] == SM::STATE_FREE)
        .map(|j| (j as u8, pd[PV::SITES + j]))
        .filter(|&(_, t)| t != keep)
        .collect();
    let plain = (0..permutation_rules::frontier::geometry::PROVINCE_TILES as u8)
        .filter(|t| *t != keep && !site_tiles.contains(t))
        .collect();
    (plain, free)
}

#[test]
#[ignore = "needs the devnet-playable .so of world 3: set PSF_PLAYABLE_SO (sha256 245ce1ab…), run with --ignored"]
fn record_playable_territory() {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert_eq!(hex::encode(so_hash), TERRITORY_SHA256, "not world 3's .so");
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
    let keeper = Keypair::new_from_array([0xA3; 32]);
    c.deploy(
        program,
        &so,
        fclient::fees::deploy_max_len(so.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    c.airdrop(&upgrade.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&payer.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&keeper.pubkey(), 50_000_000_000).unwrap();
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

    // ---- 1. The natural world.
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
    assert_eq!(cq.continuous, 1, "a continuous world");
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
            citizen: citizen.to_bytes(),
            rim_site: i as u8,
        });
    }
    r.send(
        &[&upgrade],
        &[set_rules_ix(&a, &upgrade.pubkey())],
        "WideSetRules NeutralTerritoryV1",
    );

    // ---- 2. The wide land (declared patch, then real).
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
    // (no fund top-up: `S1_DEVNET_TERRITORY`'s initial wedge funds pay the
    //  ring-129 openings; a system transfer would leave the funds' balances
    //  outside the archive, VWL `MissingData`)
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
    let rim_c = WideCoord::checked(RIM.0 as i64, RIM.1 as i64).unwrap();
    let near: Vec<WideCoord> = opened
        .iter()
        .copied()
        .filter(|c| c.distance(rim_c) == 1)
        .collect();
    let far: Vec<WideCoord> = opened
        .iter()
        .copied()
        .filter(|c| c.distance(rim_c) == 2)
        .collect();
    assert!(
        near.len() >= 2 && !far.is_empty(),
        "{opened:?} {:#?}",
        r.log
    );
    let (p0, p1, p2) = (near[0], near[1], far[0]);
    for c in &opened {
        let pd = r.data(&adr(wl::province_address(&ctx, *c))).unwrap();
        assert_eq!(
            wl::territory_rule_of(&pd),
            Some(Some(wtr::TerritoryRule::V1)),
            "a territory province"
        );
    }

    // ---- 3. Declared: the players' final Town homes at the rim.
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
    let mut home_gen = vec![];
    for (i, m) in members.iter().enumerate() {
        let (hp, hq, _) = homes[i];
        let cd = r.data(&adr(m.citizen)).unwrap();
        let o = C2::holding_of_slot(1);
        let home_site = cd[o + HR::SITE];
        let mut hd = r
            .data(&a.holding(hp.into(), hq.into(), home_site))
            .expect("the PlaceHome holding");
        hd[H::P..H::P + 2].copy_from_slice(&(RIM.0 as i16).to_le_bytes());
        hd[H::Q..H::Q + 2].copy_from_slice(&(RIM.1 as i16).to_le_bytes());
        hd[H::SITE] = m.rim_site;
        hd[H::STATE] = H::STATE_FINAL;
        hd[H::TIER] = Tier::Town as u8;
        for res in 0..RESOURCES {
            let so = H::store(res) + AC::VALUE;
            hd[so..so + 8].copy_from_slice(&STORES.to_le_bytes());
            let cap = H::store(res) + AC::CAP;
            if i64::from_le_bytes(hd[cap..cap + 8].try_into().unwrap()) < STORES {
                hd[cap..cap + 8].copy_from_slice(&STORES.to_le_bytes());
            }
        }
        let gen = hd[H::GEN];
        home_gen.push(gen);
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

    // ---- 4. REAL territory.
    let bell_now =
        |r: &Rec| frontier_abi::prologue::bell_at(genesis_ts, r.c.unix_timestamp()).unwrap();
    let next_bell = |r: &mut Rec| {
        let b = bell_now(r);
        r.advance_to(genesis_ts + 600 * (b as i64 + 1) + 5);
    };
    let pdata = |r: &Rec, c: WideCoord| r.data(&adr(wl::province_address(&ctx, c))).unwrap();
    let home_of = |m: &Member| a.holding(RIM.0, RIM.1, m.rim_site);
    let (ma, mb, mc) = (&members[0], &members[1], &members[2]);
    let (plain0, free0) = tiles_of(&pdata(&r, p0));
    let (plain1, _) = tiles_of(&pdata(&r, p1));
    let (plain2, _) = tiles_of(&pdata(&r, p2));
    assert!(!free0.is_empty() && plain0.len() > 2 && plain1.len() > 2 && !plain2.is_empty());
    let (site_a, tile_a) = free0[0];
    next_bell(&mut r);
    r.send(
        &[&ma.wallet],
        &[t_claim_tile(&a, ma, p0, tile_a, None)],
        "WideClaimTile A p0 (the tile of a free site): both records created",
    );
    r.send(
        &[&mb.wallet],
        &[t_claim_tile(&a, mb, p1, plain1[0], None)],
        "WideClaimTile B p1",
    );
    assert!(!r.try_send(
        &[&ma.wallet],
        &[t_claim_tile(&a, ma, p0, plain0[0], None)],
        "WideClaimTile A again this bell (refused: one a turn)"
    ));
    next_bell(&mut r);
    r.send(
        &[&ma.wallet],
        &[t_claim_tile(&a, ma, p2, plain2[0], None)],
        "WideClaimTile A p2 (distance 2)",
    );
    r.send(
        &[&mb.wallet],
        &[t_claim_tile(&a, mb, p1, plain1[1], None)],
        "WideClaimTile B p1 again",
    );
    next_bell(&mut r);
    let own0 = adr(wtr::province_address(&ctx, p0));
    r.send(
        &[&ma.wallet],
        &[t_claim_tile(
            &a,
            ma,
            p1,
            plain1[2],
            Some((wix::CLAIM_TILE_WITNESS_OWN, own0)),
        )],
        "WideClaimTile A p1 with an own-land witness (p0's record)",
    );
    assert!(!r.try_send(
        &[&mb.wallet],
        &[t_claim_tile(&a, mb, p1, plain1[2], None)],
        "WideClaimTile B on A's tile (refused: owned)"
    ));
    r.send(
        &[&ma.wallet],
        &[claim_site_ix(&a, ma, p0, site_a)],
        "WideClaimSite A on its own tile (T-6: the territory record as the 13th account)",
    );
    next_bell(&mut r);
    for m in [ma, mb] {
        r.send(
            &[&keeper],
            &[t_settle(&a, keeper.pubkey(), &m.citizen, home_of(m))],
            "keeper: WideTerritorySettle (paid)",
        );
    }
    r.send(
        &[&keeper],
        &[t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma))],
        "keeper: WideTerritorySettle A again in the same second",
    );

    // ---- 5a. Q-LP17-1 (b) (NOT decided by r0ze): A's home declared to make
    // 0.6 food/h net (its troop food upkeep raised to production − 600
    // milli/h), the store empty, so every turn's production is below the
    // turn's land upkeep. REAL: the settle that makes A unpaid, and the next
    // turn's settle (which reads no declared account) that TAKES the turn's
    // production (100 milli) and leaves A unpaid — before (b) it took
    // nothing.
    next_bell(&mut r);
    {
        let hk = home_of(ma);
        let mut acc = r.c.account(&hk).expect("A's home");
        let now = r.c.unix_timestamp();
        let rd = |d: &[u8], o: usize| i64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        let prod = rd(&acc.data, H::PRODUCTION);
        assert!(prod > 600, "A's home makes food: {prod}");
        let so = H::store(0);
        acc.data[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&0i64.to_le_bytes());
        acc.data[so + AC::RATE..so + AC::RATE + 8].copy_from_slice(&600i64.to_le_bytes());
        acc.data[so + AC::T0..so + AC::T0 + 8].copy_from_slice(&now.to_le_bytes());
        acc.data[so + AC::FRAC..so + AC::FRAC + 8].copy_from_slice(&0i64.to_le_bytes());
        let u = H::UPKEEP;
        acc.data[u..u + 8].copy_from_slice(&(prod - 600).to_le_bytes());
        r.put(
            hk.to_bytes(),
            acc,
            "A's first home makes 0.6 food/h net, store empty (Q-LP17-1 (b))",
        );
    }
    let tp = |r: &Rec, m: &Member| {
        TerritoryPlayer::read(&r.data(&adr(wtr::player_address(&ctx, &m.citizen))).unwrap())
            .unwrap()
    };
    let food = |r: &Rec| {
        let d = r.data(&home_of(ma)).unwrap();
        let o = H::store(0) + AC::VALUE;
        i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
    };
    r.send(
        &[&keeper],
        &[t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma))],
        "keeper: WideTerritorySettle A (short: unpaid)",
    );
    let short_since = tp(&r, ma).unpaid_since.expect("A unpaid on the short turn");
    assert!(tp(&r, ma).upkeep_per_hour().unwrap() > 600);
    next_bell(&mut r);
    r.send(
        &[&keeper],
        &[t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma))],
        "keeper: WideTerritorySettle A (short again: the turn's food taken, still unpaid)",
    );
    assert_eq!(
        tp(&r, ma).unpaid_since,
        Some(short_since),
        "still unpaid since the first short turn"
    );
    assert_eq!(food(&r), 0, "the short turn took the turn's production");

    // ---- 5. Declared starvation of A's home; REAL unpaid, then decay.
    next_bell(&mut r);
    {
        let hk = home_of(ma);
        let mut acc = r.c.account(&hk).expect("A's home");
        let now = r.c.unix_timestamp();
        let so = H::store(0);
        let max = permutation_rules::frontier::holding::MAX_UPKEEP_PER_HOUR;
        acc.data[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&0i64.to_le_bytes());
        acc.data[so + AC::RATE..so + AC::RATE + 8].copy_from_slice(&(-max).to_le_bytes());
        acc.data[so + AC::T0..so + AC::T0 + 8].copy_from_slice(&now.to_le_bytes());
        acc.data[so + AC::FRAC..so + AC::FRAC + 8].copy_from_slice(&0i64.to_le_bytes());
        let u = H::UPKEEP;
        acc.data[u..u + 8].copy_from_slice(&max.to_le_bytes());
        r.put(hk.to_bytes(), acc, "A's first home starved: food 0, food upkeep the kernel's maximum (P18's declaration, VQ-1)");
    }
    r.send(
        &[&keeper],
        &[t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma))],
        "keeper: WideTerritorySettle A (unpaid)",
    );
    assert_eq!(tp(&r, ma).unpaid_since, Some(short_since), "A unpaid");
    next_bell(&mut r);
    assert!(!r.try_send(
        &[&ma.wallet],
        &[t_claim_tile(&a, ma, p0, plain0[1], None)],
        "WideClaimTile A while unpaid (refused)"
    ));
    let unpaid = tp(&r, ma).unpaid_since.unwrap();
    r.advance_to(genesis_ts + 600 * (unpaid as i64 + 24) + 5);
    r.send(
        &[&keeper],
        &[t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma))],
        "keeper: WideTerritorySettle A (the settle-alone step)",
    );
    // the farthest first: A's p2 tile (distance 2)
    r.send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma)),
            t_decay(&a, keeper.pubkey(), &ma.citizen, p2, plain2[0]),
        ],
        "keeper: settle + WideTerritoryDecay A p2 (farthest)",
    );
    assert!(!r.try_send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma)),
            t_decay(&a, keeper.pubkey(), &ma.citizen, p0, plain0[0]),
        ],
        "keeper: a second decay in the same bell (refused)",
    ));
    next_bell(&mut r);
    // the next: one of A's distance-1 tiles (p0's site tile)
    r.send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma)),
            t_decay(&a, keeper.pubkey(), &ma.citizen, p0, tile_a),
        ],
        "keeper: settle + WideTerritoryDecay A p0 (distance 1)",
    );

    // ---- 6. Declared capture of p1's keep by C's nation; REAL conquest.
    next_bell(&mut r);
    {
        let k = wl::province_address(&ctx, p1);
        let mut acc = r.c.account(&adr(k)).expect("p1");
        let mut keep = frontier_abi::conquest_model::read_keep(&acc.data)
            .unwrap()
            .unwrap();
        keep.holder = mc.faction;
        keep.gen = keep.gen.wrapping_add(1);
        keep.contender = keep.holder;
        keep.progress = 0;
        frontier_abi::conquest_model::write_keep(&mut acc.data, &keep).unwrap();
        let cap = wl::KeepCaptor {
            home: rim_c,
            site: mc.rim_site,
            gen: home_gen[2],
            keep_gen: keep.gen,
        };
        assert!(wl::set_captor(&mut acc.data, &cap));
        r.put(k, acc, "p1's keep taken by C's nation from C's rim home (a new keep generation; the captor record the wide Resolve writes)");
    }
    let ch = home_of(mc);
    r.send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &mb.citizen, home_of(mb)),
            t_conquer(&a, keeper.pubkey(), p1, &mb.citizen, ch, &mc.citizen),
        ],
        "keeper: settle B + WideTerritoryConquer p1 (C's summary created)",
    );
    // A conquest whose captor was not settled in this second (C's summary
    // was settled by the conquest above, seconds ago) is refused
    // OutOfOrder: both summaries must be settled in the same second.
    let t_now = r.c.unix_timestamp();
    r.advance_to(t_now + 2);
    assert!(!r.try_send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma)),
            t_conquer(&a, keeper.pubkey(), p1, &ma.citizen, ch, &mc.citizen),
        ],
        "settle A + WideTerritoryConquer p1 without the captor's settle (refused OutOfOrder)",
    ));
    // The keeper's shape for a captor that already has a summary
    // (`keeper/src/territory.rs`: settle loser + settle captor + conquer in
    // ONE transaction): the captor's settle lists the captor Citizen
    // writable, so the conquest sees it writable. Lands since
    // conquest-upkeep-fix (owner Q-VT-1 (b), `TERRITORY_CONQUER`
    // `captor_citizen` Wr::Either); on world 3's first `.so` 31acbb59 it
    // was refused BadAccount every time (D-verifier-territory-1).
    r.send(
        &[&keeper],
        &[
            t_settle(&a, keeper.pubkey(), &ma.citizen, home_of(ma)),
            t_settle(&a, keeper.pubkey(), &mc.citizen, home_of(mc)),
            t_conquer(&a, keeper.pubkey(), p1, &ma.citizen, ch, &mc.citizen),
        ],
        "keeper's shape: settle A + settle C + WideTerritoryConquer p1 (the captor's second conquest)",
    );
    let tprov1 =
        TerritoryProvince::read(&r.data(&adr(wtr::province_address(&ctx, p1))).unwrap()).unwrap();
    let ctag = tp(&r, mc).citizen_tag;
    assert_eq!(
        tprov1.owned_by(ctag),
        3,
        "B's two tiles and A's one moved to C"
    );
    next_bell(&mut r);
    for m in [ma, mb, mc] {
        r.send(
            &[&keeper],
            &[t_settle(&a, keeper.pubkey(), &m.citizen, home_of(m))],
            "keeper: WideTerritorySettle",
        );
    }

    // ---- the archive
    let (txs, finals) = r.archive(&program);
    let prov = format!(
        "verify/tests/playable_territory.rs record_playable_territory: the devnet-playable .so of world 3 (sha256 {TERRITORY_SHA256}) in localnet::Chain (LiteSVM, in process); a real S1_DEVNET_TERRITORY world (0x4804, NeutralTerritoryV1), every set_account patch declared; steps: {}",
        r.log.join("; ")
    );
    let mut whole = input_of(
        program,
        so_hash,
        txs,
        finals,
        r.c.slot(),
        prov,
        r.declared.clone(),
    );
    // What getTransaction serves beside each transaction (`meta.preBalances`
    // / `postBalances`), the ProgramData's upgrade authority and the chain's
    // Rent sysvar: VG's input (an archive without post-states replayed from
    // genesis, as a public RPC's archive of world 3 would be).
    let rent_acc =
        r.c.account(&fclient::rent::rent_sysvar())
            .expect("the chain's Rent sysvar");
    let landed = r.c.feed(0, usize::MAX, Some(&program));
    whole.chain = verify_core::input::ChainWitness {
        lookup_snapshots: vec![],
        balances: landed
            .iter()
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
        rent: Some(
            verify_core::input::RentRead::from_chain(&rent_acc.data, r.c.slot())
                .expect("a Rent sysvar"),
        ),
        lookup_tables: None,
    };
    for l in &r.log {
        println!("{l}");
    }
    let mut judged = whole.clone();
    judged.program_so = Some(std::sync::Arc::new(so.clone()));
    let rep = verify_core::verify(&judged);
    println!("verdict {:?}", rep.verdict);
    for f in &rep.findings {
        println!(
            "{:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    let mut rpc = judged.clone();
    for t in rpc.txs.iter_mut() {
        t.post.clear();
    }
    let rep = verify_core::verify(&rpc);
    println!("VG verdict {:?}", rep.verdict);
    for f in &rep.findings {
        println!(
            "VG {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    if let Ok(dir) = std::env::var("PLAYABLE_WIDE_DUMP") {
        let d = std::path::Path::new(&dir);
        whole.save(&d.join(WHOLE)).expect("save");
        println!("saved to {dir}");
    }
}

// ------------------------------------------------------------ the committed recording

fn whole() -> Input {
    common::fixture(WHOLE)
}

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(
        hex::encode(p.sha256()),
        TERRITORY_SHA256,
        "the committed .so is world 3's"
    );
    std::sync::Arc::new(p.so.as_ref().clone())
}

fn with_so(mut inp: Input) -> Input {
    inp.program_so = Some(so());
    inp
}

/// The program instructions of `t`: (data, account keys).
fn ixs_of(inp: &Input, t: usize) -> Vec<(Vec<u8>, Vec<[u8; 32]>)> {
    let Ok(tx) = fclient::tx::from_wire(&inp.txs[t].tx) else {
        return vec![];
    };
    let keys = &tx.message.account_keys;
    tx.message
        .instructions
        .iter()
        .filter(|c| keys[c.program_id_index as usize] == inp.cfg.program)
        .map(|c| {
            (
                c.data.clone(),
                c.accounts
                    .iter()
                    .map(|&i| keys[i as usize].to_bytes())
                    .collect(),
            )
        })
        .collect()
}

fn cmd(d: &[u8]) -> Option<wix::WideCommand<'_>> {
    wix::WideCommand::decode(d).ok()
}

/// The successful transactions whose program instructions match `f`.
fn txs_where(inp: &Input, f: impl Fn(&[wix::WideCommand]) -> bool) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_none())
        .filter(|&t| {
            let ixs = ixs_of(inp, t);
            let cs: Option<Vec<_>> = ixs.iter().map(|(d, _)| cmd(d)).collect();
            cs.is_some_and(|cs| !cs.is_empty() && f(&cs))
        })
        .collect()
}

fn is_terr(c: &wix::WideCommand) -> bool {
    use wix::WideCommand as W;
    matches!(
        c,
        W::ClaimTile(_) | W::TerritorySettle(_) | W::TerritoryDecay(_) | W::TerritoryConquer(_)
    )
}

fn territory_txs(inp: &Input) -> Vec<usize> {
    txs_where(inp, |cs| cs.iter().all(is_terr))
}

fn claims(inp: &Input) -> Vec<usize> {
    txs_where(inp, |cs| matches!(cs, [wix::WideCommand::ClaimTile(_)]))
}

fn decays(inp: &Input) -> Vec<usize> {
    txs_where(inp, |cs| {
        cs.iter()
            .any(|c| matches!(c, wix::WideCommand::TerritoryDecay(_)))
    })
}

fn conquers(inp: &Input) -> Vec<usize> {
    txs_where(inp, |cs| {
        cs.iter()
            .any(|c| matches!(c, wix::WideCommand::TerritoryConquer(_)))
    })
}

fn settles_alone(inp: &Input) -> Vec<usize> {
    txs_where(inp, |cs| {
        matches!(cs, [wix::WideCommand::TerritorySettle(_)])
    })
}

fn sig(inp: &Input, t: usize) -> String {
    inp.txs[t].signature.to_string()
}

fn at(rep: &[Finding], inp: &Input, t: usize) -> Vec<(String, String, String)> {
    rep.iter()
        .filter(|f| f.signature == sig(inp, t) || f.entity == format!("tx#{t}"))
        .map(|f| (f.check.to_string(), f.code.clone(), f.detail.clone()))
        .collect()
}

fn fails_at(rep: &[Finding], inp: &Input, t: usize, code: &str, text: &str) -> bool {
    rep.iter().any(|f| {
        f.severity == Severity::Fail
            && f.check == "VWL"
            && f.code == code
            && (f.signature == sig(inp, t) || f.entity == format!("tx#{t}"))
            && f.detail.contains(text)
    })
}

fn show(rep: &[Finding]) -> Vec<(String, String, String, String)> {
    rep.iter()
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

/// Whether transaction `t` reads, directly, a state only a declared patch
/// made (a patch after the last archived write of an account it names).
fn reads_declared(inp: &Input, t: usize) -> bool {
    let named: Vec<[u8; 32]> = ixs_of(inp, t).into_iter().flat_map(|(_, k)| k).collect();
    inp.declared.iter().any(|d| {
        d.at <= t
            && named.contains(&d.key)
            && !(d.at..t).any(|u| {
                inp.txs[u].err.is_none()
                    && inp.txs[u].post.iter().any(|(k, _)| k.to_bytes() == d.key)
            })
    })
}

fn edit_post(inp: &mut Input, t: usize, k: &[u8; 32], f: impl FnOnce(&mut Account)) {
    let (_, a) = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x.to_bytes() == *k)
        .expect("a post-state");
    f(a.as_mut().expect("present"));
}

/// Rewrites the data of program instruction `n` of transaction `t` (the
/// signature is not re-made: VWL does not judge signatures).
fn edit_ix(inp: &mut Input, t: usize, n: usize, f: impl FnOnce(&mut Vec<u8>)) {
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let program = inp.cfg.program;
    let keys = tx.message.account_keys.clone();
    let ci = tx
        .message
        .instructions
        .iter_mut()
        .filter(|c| keys[c.program_id_index as usize] == program)
        .nth(n)
        .unwrap();
    f(&mut ci.data);
    inp.txs[t].tx = fclient::tx::wire(&tx);
}

fn vwl(inp: &Input) -> Vec<Finding> {
    verify_core::verify(inp)
        .findings
        .into_iter()
        .filter(|f| f.check == "VWL")
        .collect()
}

// ------------------------------------------------------------ the tests (CI)

#[test]
fn the_recording_exercises_every_territory_path() {
    let inp = whole();
    let ts = territory_txs(&inp);
    assert!(claims(&inp).len() >= 5, "claims");
    assert!(decays(&inp).len() >= 2, "decays");
    assert_eq!(conquers(&inp).len(), 2, "conquests");
    assert!(settles_alone(&inp).len() >= 6, "plain settles");
    assert!(ts.len() >= 15, "{}", ts.len());
    // the keeper's multi-instruction transactions
    let multi: Vec<_> = ts.iter().filter(|&&t| ixs_of(&inp, t).len() > 1).collect();
    assert_eq!(
        multi.len(),
        4,
        "two settle+decay, settle+conquer, settle×2+conquer"
    );
    // a captor summary created by a conquest; a claim with a witness
    let witnessed = claims(&inp)
        .into_iter()
        .filter(|&t| matches!(cmd(&ixs_of(&inp, t)[0].0), Some(wix::WideCommand::ClaimTile(x)) if x.witness == 2))
        .count();
    assert_eq!(witnessed, 1);
    // refused territory transactions are archived (not judged)
    let refused = (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_some())
        .filter(|&t| {
            ixs_of(&inp, t)
                .iter()
                .any(|(d, _)| cmd(d).as_ref().is_some_and(is_terr))
        })
        .count();
    assert!(refused >= 4, "{refused}");
    // the WideClaimSite on an own tile (13 accounts, the territory record)
    let sites = txs_where(&inp, |cs| matches!(cs, [wix::WideCommand::ClaimSite(_)]));
    assert_eq!(sites.len(), 1);
    assert_eq!(ixs_of(&inp, sites[0])[0].1.len(), 13);
}

/// The honest world, whole, in season mode with world 3's `.so`: no FAIL
/// anywhere; every territory transaction re-judged — PASS, except the ones
/// that read a declared patch's state directly (`MissingData`, "only
/// declares"); no wide instruction left `WideUnmodelled`.
#[test]
fn the_honest_territory_world_has_no_fail_and_every_territory_tx_is_judged() {
    let inp = with_so(whole());
    let rep = verify_core::verify(&inp);
    let fails: Vec<_> = rep.findings.iter().filter(|f| f.fail()).collect();
    assert!(
        fails.is_empty(),
        "{:#?}",
        fails
            .iter()
            .map(|f| (f.check, &f.code, &f.entity, &f.detail))
            .collect::<Vec<_>>()
    );
    assert_eq!(rep.verdict, Verdict::Unverifiable, "the declared patches");
    assert!(
        !rep.findings
            .iter()
            .any(|f| f.code == "WideUnmodelled" || f.code == "UnverifiedInstruction"),
        "{:#?}",
        show(&rep.findings)
    );
    let mut passed = 0;
    for t in territory_txs(&inp) {
        let here = at(&rep.findings, &inp, t);
        if reads_declared(&inp, t) {
            assert!(
                here.iter()
                    .all(|(_, c, d)| c == "MissingData" && d.contains("declare")),
                "tx#{t}: {here:#?}"
            );
        } else {
            assert!(here.is_empty(), "tx#{t}: {here:#?}");
            passed += 1;
        }
    }
    // 9 since conquest-upkeep-fix: the keeper's second-conquest shape lands
    // in one transaction, so the recording no longer holds the lone captor
    // settles of the old same-second retry (31acbb59)
    assert!(passed >= 9, "{passed} territory transactions PASS outright");
    // every Unverifiable finding of the world is a declared patch showing
    let other: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Unverifiable)
        .filter(|f| {
            !(f.detail.contains("declare") || f.code == "MissingData" && f.detail.contains("patch"))
        })
        .map(|f| (f.check, f.code.clone(), f.entity.clone(), f.detail.clone()))
        .collect();
    assert!(other.is_empty(), "{other:#?}");
}

/// V0 and VX leave the territory instructions to VWL.
#[test]
fn v0_and_vx_leave_territory_to_vwl() {
    use verify_core::checks::{v0_coverage as v0, vx_reexec as vx};
    let inp = whole();
    for t in territory_txs(&inp) {
        for (d, _) in ixs_of(&inp, t) {
            assert!(v0::vwl_judged(&d), "tx#{t}");
            assert!(!vx::judged(&d), "tx#{t}");
        }
    }
}

// ---- tampers

/// A claim the program refuses (a tile another player owns) re-judged: FAIL.
#[test]
fn a_claim_of_an_owned_tile_fails() {
    let mut inp = whole();
    let cs = claims(&inp);
    // B's second claim in p1 (bell 2) → name the tile B claimed first
    let (t1, t2) = (cs[1], cs[3]);
    let first_tile = match cmd(&ixs_of(&inp, t1)[0].0) {
        Some(wix::WideCommand::ClaimTile(x)) => x.tile,
        _ => unreachable!(),
    };
    edit_ix(&mut inp, t2, 0, |d| d[20] = first_tile);
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t2, "WideRule", "AlreadyYours"),
        "{:#?}",
        show(&f)
    );
}

/// A claim while upkeep is unpaid (the refused claim, forged as landed with
/// the post-states a claim would leave): FAIL.
#[test]
fn a_claim_while_unpaid_fails() {
    let mut inp = whole();
    // the refused claim after the unpaid settle
    let t = (0..inp.txs.len())
        .rev()
        .find(|&t| {
            inp.txs[t].err.is_some()
                && matches!(ixs_of(&inp, t).as_slice(), [(d, _)] if matches!(cmd(d), Some(wix::WideCommand::ClaimTile(_))))
        })
        .unwrap();
    inp.txs[t].err = None;
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "UpkeepUnpaid"),
        "{:#?}",
        show(&f)
    );
}

/// A claim that did not pay its ore: FAIL.
#[test]
fn a_claim_that_kept_its_ore_fails() {
    let mut inp = whole();
    let t = claims(&inp)[3];
    let home = ixs_of(&inp, t)[0].1[7];
    edit_post(&mut inp, t, &home, |a| {
        let o = H::store(3) + AC::VALUE;
        let v = i64::from_le_bytes(a.data[o..o + 8].try_into().unwrap()) + 10_000;
        a.data[o..o + 8].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
}

/// Wrong upkeep: a settle whose home kept the food it was charged, or whose
/// summary moved its clock elsewhere: FAIL.
#[test]
fn a_wrong_upkeep_settle_fails() {
    let base = whole();
    // a paid settle that charged food (not the first after a patch)
    let t = settles_alone(&base)
        .into_iter()
        .find(|&t| {
            !reads_declared(&base, t)
                && base.txs[t]
                    .post
                    .iter()
                    .any(|(k, _)| k.to_bytes() == ixs_of(&base, t)[0].1[4])
        })
        .expect("a settle that charged the home");
    let ks = ixs_of(&base, t)[0].1.clone();
    let mut inp = base.clone();
    edit_post(&mut inp, t, &ks[4], |a| {
        let o = H::store(0) + AC::VALUE;
        let v = i64::from_le_bytes(a.data[o..o + 8].try_into().unwrap()) + 1;
        a.data[o..o + 8].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
    // the summary: paid_to off by one second
    let mut inp = base.clone();
    edit_post(&mut inp, t, &ks[2], |a| {
        let mut pl = TerritoryPlayer::read(&a.data).unwrap();
        pl.paid_to -= 1;
        pl.write(&mut a.data).unwrap();
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
    // an unpaid mark that never happened
    let mut inp = base;
    edit_post(&mut inp, t, &ks[2], |a| {
        let mut pl = TerritoryPlayer::read(&a.data).unwrap();
        pl.unpaid_since = Some(1);
        pl.write(&mut a.data).unwrap();
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
}

/// Decay out of order: the first decay naming a nearer tile while a
/// farther one is owned: FAIL (NotFarthest).
#[test]
fn a_decay_out_of_order_fails() {
    let mut inp = whole();
    let ds = decays(&inp);
    let (first, second) = (ds[0], ds[1]);
    // the second decay's tile (distance 1) and province, into the first
    let (d2, k2) = ixs_of(&inp, second)[1].clone();
    edit_ix(&mut inp, first, 1, |d| d[4] = d2[4]);
    let mut tx = fclient::tx::from_wire(&inp.txs[first].tx).unwrap();
    // the province record account of the decay → the second's
    let keys = tx.message.account_keys.clone();
    let program = inp.cfg.program;
    let ci = tx
        .message
        .instructions
        .iter()
        .filter(|c| keys[c.program_id_index as usize] == program)
        .nth(1)
        .unwrap()
        .clone();
    let slot = ci.accounts[3] as usize;
    tx.message.account_keys[slot] = Address::new_from_array(k2[3]);
    inp.txs[first].tx = fclient::tx::wire(&tx);
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, first, "WideRule", "farthest"),
        "{:#?}",
        show(&f)
    );
}

/// A decay without the settle in the same second (alone in its
/// transaction): FAIL (OutOfOrder).
#[test]
fn a_decay_without_its_settle_fails() {
    let mut inp = whole();
    // (the second decay: its settle is only the one in its own transaction;
    //  the first follows a settle-alone transaction of the same second)
    let t = decays(&inp)[1];
    // drop the settle: keep only the decay instruction
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let keys = tx.message.account_keys.clone();
    let program = inp.cfg.program;
    tx.message.instructions.retain(|c| {
        keys[c.program_id_index as usize] != program
            || cmd(&c.data).is_some_and(|c| matches!(c, wix::WideCommand::TerritoryDecay(_)))
    });
    inp.txs[t].tx = fclient::tx::wire(&tx);
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "this second"),
        "{:#?}",
        show(&f)
    );
}

/// A decay before the grace ran out: the summary's unpaid mark (as the
/// transaction before the first decay left it) 20 bells later, so only 4
/// unpaid bells have passed at the decay: FAIL (not due).
#[test]
fn a_decay_before_the_grace_fails() {
    let mut inp = whole();
    let t = decays(&inp)[0];
    let summary = ixs_of(&inp, t)[0].1[2];
    let w = (0..t)
        .rev()
        .find(|&u| {
            inp.txs[u].err.is_none() && inp.txs[u].post.iter().any(|(k, _)| k.to_bytes() == summary)
        })
        .unwrap();
    edit_post(&mut inp, w, &summary, |a| {
        let mut pl = TerritoryPlayer::read(&a.data).unwrap();
        pl.unpaid_since = pl.unpaid_since.map(|u| u + 20);
        pl.write(&mut a.data).unwrap();
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "not due"),
        "{:#?}",
        show(&f)
    );
}

/// A conquest that moved a tile the program keeps with its owner (the
/// captor gained one more tile than the transfer gives): FAIL.
#[test]
fn a_forged_conquest_fails() {
    let mut inp = whole();
    let t = conquers(&inp)[0];
    let tprov = ixs_of(&inp, t).last().unwrap().1[3];
    edit_post(&mut inp, t, &tprov, |a| {
        let mut r = TerritoryProvince::read(&a.data).unwrap();
        let i = (0..permutation_rules::frontier::geometry::PROVINCE_TILES)
            .find(|&i| r.owner[i] == 0 && i as u8 != r.keep_tile)
            .unwrap();
        r.owner[i] = r.owner.iter().copied().find(|o| *o != 0).unwrap();
        r.dist[i] = 1;
        r.write(&mut a.data).unwrap();
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
}

/// A conquest whose summaries were not settled in its second (the settle
/// dropped from the transaction): FAIL (OutOfOrder).
#[test]
fn a_conquest_without_its_settles_fails() {
    let mut inp = whole();
    let t = conquers(&inp)[1];
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let keys = tx.message.account_keys.clone();
    let program = inp.cfg.program;
    tx.message.instructions.retain(|c| {
        keys[c.program_id_index as usize] != program
            || cmd(&c.data).is_some_and(|c| matches!(c, wix::WideCommand::TerritoryConquer(_)))
    });
    inp.txs[t].tx = fclient::tx::wire(&tx);
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "this second"),
        "{:#?}",
        show(&f)
    );
}

/// A WideClaimSite in a territory world on a site whose tile the claimer
/// does not own: FAIL (T-6).
#[test]
fn a_village_off_the_claimers_land_fails() {
    let mut inp = whole();
    let t = txs_where(&inp, |cs| matches!(cs, [wix::WideCommand::ClaimSite(_)]))[0];
    // the site → another free site of the province (its tile unowned)
    edit_ix(&mut inp, t, 0, |d| {
        let x = wix::ClaimSite::decode(d).unwrap();
        let mut y = x;
        y.site = (x.site + 1) % 4;
        d.copy_from_slice(&y.to_bytes());
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "not the claimer's"),
        "{:#?}",
        show(&f)
    );
}

/// The conquest refused because the captor was not settled in this second
/// (settle loser + conquer only, two seconds after the captor's summary was
/// last settled) forged as landed: FAIL.
#[test]
fn a_conquest_without_the_captors_settle_forged_as_landed_fails() {
    let mut inp = whole();
    let t = (0..inp.txs.len())
        .find(|&t| {
            inp.txs[t].err.is_some() && {
                let ixs = ixs_of(&inp, t);
                ixs.len() == 2
                    && matches!(cmd(&ixs[1].0), Some(wix::WideCommand::TerritoryConquer(_)))
            }
        })
        .expect("the refused conquest without the captor's settle");
    inp.txs[t].err = None;
    inp.txs[t].code = None;
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideRule", "not settled in this second"),
        "{:#?}",
        show(&f)
    );
}

/// Q-VT-1 (b), conquest-upkeep-fix: the keeper's shape for a captor that
/// already has a summary (settle loser + settle captor + conquer in ONE
/// transaction, the captor Citizen writable in that message) LANDED on the
/// fixed `.so`, and VWL judges it (no FAIL at it; the captor's tiles moved).
#[test]
fn the_keepers_second_conquest_shape_landed_and_passes() {
    let inp = whole();
    let t = (0..inp.txs.len())
        .find(|&t| {
            inp.txs[t].err.is_none() && {
                let ixs = ixs_of(&inp, t);
                ixs.len() == 3
                    && matches!(cmd(&ixs[2].0), Some(wix::WideCommand::TerritoryConquer(_)))
            }
        })
        .expect("the landed keeper-shape conquest");
    let f = vwl(&inp);
    assert!(!f.iter().any(|x| x.fail()), "{:#?}", show(&f));
    assert!(inp.txs[t].err.is_none());
}

/// The world as a public RPC would serve world 3's archive (no post-states,
/// the chain's balances): VG re-executes it from genesis with world 3's
/// `.so`, then VWL judges the derived states — no FAIL, the same declared
/// patches only, every territory transaction re-run.
#[test]
fn vg_replays_the_territory_world_from_genesis_without_a_fail() {
    let mut inp = with_so(whole());
    assert_eq!(
        inp.chain.balances.len(),
        inp.txs.len(),
        "the chain's balances"
    );
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    let rep = verify_core::verify(&inp);
    let fails: Vec<_> = rep.findings.iter().filter(|f| f.fail()).collect();
    assert!(fails.is_empty(), "{:#?}", show(&rep.findings));
    assert!(
        !rep.findings.iter().any(|f| f.check == "VG"),
        "{:#?}",
        show(&rep.findings)
    );
    let other: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Unverifiable && !f.detail.contains("declare"))
        .map(|f| (f.check, f.code.clone(), f.detail.clone()))
        .collect();
    assert!(other.is_empty(), "{other:#?}");
}

// ------------------------------------------------------------ verify-pr228 (independent tampers)

/// The refused transactions of the recording whose program instructions are
/// exactly `f`'s shape.
fn refused_where(inp: &Input, f: impl Fn(&[wix::WideCommand]) -> bool) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| inp.txs[t].err.is_some())
        .filter(|&t| {
            let ixs = ixs_of(inp, t);
            let cs: Option<Vec<_>> = ixs.iter().map(|(d, _)| cmd(d)).collect();
            cs.is_some_and(|cs| !cs.is_empty() && f(&cs))
        })
        .collect()
}

/// verify-pr228: every claim the program refused in the recording (turn
/// limit, an owned tile, a claim while unpaid), forged as landed: each one
/// FAILs at its own transaction with the territory rule's reason.
#[test]
fn verify_pr228_every_refused_claim_forged_as_landed_fails_with_its_reason() {
    let base = whole();
    let refused = refused_where(&base, |cs| matches!(cs, [wix::WideCommand::ClaimTile(_)]));
    assert!(refused.len() >= 3, "the refused claims: {refused:?}");
    let mut reasons = vec![];
    for &t in &refused {
        let mut inp = base.clone();
        inp.txs[t].err = None;
        inp.txs[t].code = None;
        let f = vwl(&inp);
        let here: Vec<_> = f
            .iter()
            .filter(|x| {
                x.severity == Severity::Fail
                    && (x.signature == sig(&inp, t) || x.entity == format!("tx#{t}"))
            })
            .map(|x| x.detail.clone())
            .collect();
        assert!(!here.is_empty(), "tx {t}: {:#?}", show(&f));
        reasons.extend(here);
    }
    for want in ["TurnLimit", "Owned", "UpkeepUnpaid"] {
        assert!(
            reasons.iter().any(|r| r.contains(want)),
            "{want} in {reasons:#?}"
        );
    }
}

/// verify-pr228: the second decay of one bell (refused by the program),
/// forged as landed: FAIL.
#[test]
fn verify_pr228_a_second_decay_in_one_bell_forged_as_landed_fails() {
    let mut inp = whole();
    let t = refused_where(&inp, |cs| {
        cs.iter()
            .any(|c| matches!(c, wix::WideCommand::TerritoryDecay(_)))
    })[0];
    inp.txs[t].err = None;
    inp.txs[t].code = None;
    let f = vwl(&inp);
    assert!(
        f.iter().any(|x| x.severity == Severity::Fail
            && (x.signature == sig(&inp, t) || x.entity == format!("tx#{t}"))),
        "{:#?}",
        show(&f)
    );
}

/// verify-pr228: a conquest of a TEAMMATE's tiles (T-8): the loser's summary
/// as the transaction before the conquest left it, its nation set to the
/// captor's. The conquest FAILs with the teammate rule (NotEligible).
#[test]
fn verify_pr228_a_conquest_of_a_teammates_tiles_fails() {
    for n in 0..2 {
        let mut inp = whole();
        let t = conquers(&inp)[n];
        let conquer = ixs_of(&inp, t).last().unwrap().1.clone();
        let (loser, captor) = (conquer[4], conquer[7]);
        let cap = TerritoryPlayer::read(
            &inp.txs[t]
                .post
                .iter()
                .find(|(k, _)| k.to_bytes() == captor)
                .unwrap()
                .1
                .as_ref()
                .unwrap()
                .data,
        )
        .unwrap();
        let w = (0..t)
            .rev()
            .find(|&u| {
                inp.txs[u].err.is_none()
                    && inp.txs[u].post.iter().any(|(k, _)| k.to_bytes() == loser)
            })
            .unwrap();
        edit_post(&mut inp, w, &loser, |a| {
            let mut pl = TerritoryPlayer::read(&a.data).unwrap();
            assert_ne!(pl.faction, cap.faction);
            pl.faction = cap.faction;
            pl.write(&mut a.data).unwrap();
        });
        let f = vwl(&inp);
        assert!(
            fails_at(&f, &inp, t, "WideRule", "teammate"),
            "conquest {n}: {:#?}",
            show(&f)
        );
    }
}

/// verify-pr228: a conquest whose post-state hands the loser's tiles to a
/// different owner tag than the captor's: FAIL (the re-run's bytes).
#[test]
fn verify_pr228_a_conquest_to_the_wrong_owner_fails() {
    let mut inp = whole();
    let t = conquers(&inp)[0];
    let tprov = ixs_of(&inp, t).last().unwrap().1[3];
    edit_post(&mut inp, t, &tprov, |a| {
        let mut r = TerritoryProvince::read(&a.data).unwrap();
        let i = (0..permutation_rules::frontier::geometry::PROVINCE_TILES)
            .find(|&i| r.owner[i] != 0)
            .unwrap();
        r.owner[i] ^= 1;
        r.write(&mut a.data).unwrap();
    });
    let f = vwl(&inp);
    assert!(
        fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
        "{:#?}",
        show(&f)
    );
}

/// verify-pr228: a settle that charged too LITTLE food (the home kept part
/// of the upkeep) and one that charged too MUCH: both FAIL.
#[test]
fn verify_pr228_upkeep_off_by_one_either_way_fails() {
    let base = whole();
    let t = settles_alone(&base)
        .into_iter()
        .find(|&t| {
            !reads_declared(&base, t)
                && base.txs[t]
                    .post
                    .iter()
                    .any(|(k, _)| k.to_bytes() == ixs_of(&base, t)[0].1[4])
        })
        .expect("a settle that charged the home");
    let home = ixs_of(&base, t)[0].1[4];
    for d in [-1000i64, 1000] {
        let mut inp = base.clone();
        edit_post(&mut inp, t, &home, |a| {
            let o = H::store(0) + AC::VALUE;
            let v = i64::from_le_bytes(a.data[o..o + 8].try_into().unwrap()) + d;
            a.data[o..o + 8].copy_from_slice(&v.to_le_bytes());
        });
        let f = vwl(&inp);
        assert!(
            fails_at(&f, &inp, t, "WideReplayMismatch", "re-run"),
            "{d}: {:#?}",
            show(&f)
        );
    }
}

/// Q-LP17-1 (b) (NOT decided by r0ze): the short settle that read no
/// declared account took the turn's food and left A unpaid. Forged so that
/// the home KEPT its food (the old all-or-nothing outcome), or so that the
/// summary went paid: both FAIL.
#[test]
fn qlp17_a_short_settle_that_kept_the_food_or_went_paid_fails() {
    let base = whole();
    let t = settles_alone(&base)
        .into_iter()
        .find(|&t| {
            let ks = &ixs_of(&base, t)[0].1;
            !reads_declared(&base, t)
                && base.txs[t].post.iter().any(|(k, _)| k.to_bytes() == ks[4])
                && base.txs[t].post.iter().any(|(k, a)| {
                    k.to_bytes() == ks[2]
                        && a.as_ref().is_some_and(|a| {
                            TerritoryPlayer::read(&a.data).is_ok_and(|p| p.unpaid_since.is_some())
                        })
                })
        })
        .expect("a short settle that charged the home and stayed unpaid");
    let ks = ixs_of(&base, t)[0].1.clone();
    let (home, player) = (ks[4], ks[2]);
    let mut kept = base.clone();
    edit_post(&mut kept, t, &home, |a| {
        let o = H::store(0) + AC::VALUE;
        let v = i64::from_le_bytes(a.data[o..o + 8].try_into().unwrap()) + 100;
        a.data[o..o + 8].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl(&kept);
    assert!(
        fails_at(&f, &kept, t, "WideReplayMismatch", "re-run"),
        "kept: {:#?}",
        show(&f)
    );
    let mut paid = base.clone();
    edit_post(&mut paid, t, &player, |a| {
        let mut pl = TerritoryPlayer::read(&a.data).unwrap();
        pl.unpaid_since = None;
        pl.write(&mut a.data).unwrap();
    });
    let f = vwl(&paid);
    assert!(
        fails_at(&f, &paid, t, "WideReplayMismatch", "re-run"),
        "paid: {:#?}",
        show(&f)
    );
}

/// verify-pr228: the verdict is deterministic: the same archive judged twice
/// (with and without the .so) gives the same findings in the same order.
#[test]
fn verify_pr228_the_verdict_is_deterministic() {
    for inp in [whole(), with_so(whole())] {
        let a = verify_core::verify(&inp);
        let b = verify_core::verify(&inp);
        assert_eq!(format!("{:?}", a.verdict), format!("{:?}", b.verdict));
        assert_eq!(show(&a.findings), show(&b.findings));
    }
}
