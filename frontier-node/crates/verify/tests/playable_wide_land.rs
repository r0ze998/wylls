//! VWL — the wide land opening of the PLAYABLE lane (0x4804) under the
//! verifier's `playable-lane` feature (Q16-1 = A continued, 2026-11-18).
//!
//! Two recordings of the devnet-playable `.so` built from `origin/main` `faf1a520` (sha256 ec511123…; not deployed)
//! in the in-process LiteSVM chain (`localnet::Chain`), made by
//! `record_playable_wide_land` (ignored; needs the artefact):
//!
//! * `playable-wide-setrules.json.gz`: a REAL season by its own
//!   instructions only (AnnounceSeason → … → OpenRing → OpenProvince, as
//!   `playable_lane.rs`), then the Season authority's real **WideSetRules**.
//!   Every transaction from genesis on is in the archive, so it is judged
//!   as a whole season: PASS.
//! * `playable-wide-land-segment.json.gz` + `…-snapshot.json.gz`: after
//!   that, a **declared fixture patch** and a witnessed segment. No natural
//!   season of this build can reach ring 129: WideRequestRingSeed(129)
//!   needs the legacy RingSeed of ring 128 seeded, which needs OpenRing up
//!   to 128 (S1_LOCAL_7D has `r_max` 16; each ring past the genesis rings
//!   needs its own drand round a bell apart, and the workspace ships 32
//!   rounds, no network). So the recorder writes with `Chain::set_account`
//!   exactly two things: the legacy RingSeed of ring 128 (a copy of a
//!   real seeded RingSeed with `d = 128`, `opened_bell = 0`) and the
//!   Frontier's wedge counters (every open wedge occupied, so θ holds).
//!   Then everything is REAL: **WideRequestRingSeed(129)** (bound to a
//!   shipped quicknet round by the chain's time), **WideConsumeRingSeed**
//!   with that round's real signature, and **WideOpenProvince** of one
//!   province per wedge of ring 129. The snapshot holds the state of every
//!   account the segment's instructions name, read from the chain before
//!   the segment's first transaction (an execution witness, as reth's
//!   `ExecutionWitness`); VWL judges the segment from it
//!   (`vwl_wide_land::judge_segment`). A season verdict of such a world is
//!   not claimed: the patch is not an instruction.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_WIDE_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_wide_land -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::ports::Account;
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use frontier_abi::world_index::{
    land as wl,
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    wide_ix as wix, WideCoord,
};
use permutation_rules::frontier::beacon::{
    genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time, BeaconClock,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use verify_core::checks::vwl_wide_land as vwl;
use verify_core::input::{Config, Input};
use verify_core::Verdict;

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
const PLAYABLE_SHA256: &str = "ec511123493c23e9ab1f83295e4bf666bc48c8e3f8dcfee2298d9371cc483ca3";
/// One candidate per rule, the Free City and the camp drawn (so the
/// opening exercises every kernel the configuration can name).
const RULES: wr::RuleBytes = wr::RuleBytes {
    keep_holder: KeepHolderRule::MixedInterleaved as u8,
    // (⑧ (d), #69: a placement-2 Season — `S1_LOCAL_7D` since #69 — takes
    //  the deployed formula; `CanonicalHashV1` is refused `BadData`)
    free_city: FreeCityRule::DeployedLe32V1 as u8,
    camp: CampRule::SortKeyDrawV1 as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
/// One province per wedge of ring 129.
const OPENINGS: [(i64, i64); 6] = [
    (129, 0),
    (0, 129),
    (-129, 129),
    (-129, 0),
    (0, -129),
    (129, -129),
];

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
        heap: None,
    }
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
    /// While recording the witnessed segment: the pre-state of every
    /// account a segment instruction names, read before its first use.
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
                    let a = self
                        .c
                        .account(&m.pubkey)
                        .filter(|a| a.owner == self.a.program);
                    snap.insert(k, a);
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
    /// The archive of every program transaction from `from_seq` on.
    fn archive(
        &self,
        from: usize,
        program: &Address,
    ) -> (
        Vec<fclient::ports::TxRecord>,
        BTreeMap<[u8; 32], Option<Account>>,
    ) {
        let mut txs: Vec<fclient::ports::TxRecord> = self
            .c
            .feed(0, usize::MAX, Some(program))
            .into_iter()
            .map(|l| l.record())
            .skip(from)
            .collect();
        let mut owned = std::collections::BTreeSet::new();
        for t in txs.iter_mut() {
            t.post
                .retain(|(_, a)| a.as_ref().is_some_and(|a| a.owner == *program));
            for (k, _) in &t.post {
                owned.insert(*k);
            }
        }
        let finals = owned
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

fn wide_ix(a: &Addresses, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts,
        data,
    }
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
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
    let previous = if ring == wl::FIRST_WIDE_RING {
        adr(c.ring_seed(128))
    } else {
        adr(wl::ring_seed_address(&c, ring - 1))
    };
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.frontier(), false),
        AccountMeta::new_readonly(previous, false),
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

#[test]
#[ignore = "needs the devnet-playable .so: set PSF_PLAYABLE_SO (sha256 ec511123…), run with --ignored"]
fn record_playable_wide_land() {
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

    // ---- The natural season (as playable_lane.rs), then WideSetRules.
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
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
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
    'home: for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 == ring
                    && home_nation(coord, cq.placement, cq.heartland_max_ring, &seed).is_some()
                {
                    r.send(
                        &[&payer],
                        &[ix::open_province(&a, payer.pubkey(), pp as i16, qq as i16)],
                        "OpenProvince",
                    );
                    break 'home;
                }
            }
        }
    }
    // Before the rules, the wide opening is refused (no configuration);
    // a refused transaction is archived and not judged.
    r.try_send(
        &[&payer],
        &[open_ix(&a, &payer.pubkey(), 129, 0)],
        "WideOpenProvince before any ring seed (refused)",
    );
    r.send(
        &[&upgrade],
        &[set_rules_ix(&a, &upgrade.pubkey())],
        "WideSetRules",
    );
    // A second configuration is refused (write-once).
    r.try_send(
        &[&upgrade],
        &[set_rules_ix(&a, &upgrade.pubkey())],
        "WideSetRules again (refused)",
    );
    // Ring 129 cannot be requested in a natural season: ring 128 is not open.
    r.try_send(
        &[&payer],
        &[request_ix(&a, &payer.pubkey(), 129)],
        "WideRequestRingSeed(129) naturally (refused)",
    );

    let (txs, finals) = r.archive(0, &program);
    let natural_len = txs.len();
    let natural = input_of(
        program,
        so_hash,
        txs,
        finals,
        r.c.slot(),
        format!(
            "verify/tests/playable_wide_land.rs record_playable_wide_land: the devnet-playable .so (sha256 {PLAYABLE_SHA256}) in localnet::Chain (LiteSVM, in process), a real season by its own instructions at program version 0x4804 (genesis on the shipped quicknet round {round}), then the Season authority's real WideSetRules; steps: {}",
            r.log.join("; ")
        ),
        "playable-wide-setrules",
    );
    let rep = verify_core::verify(&natural);
    for f in &rep.findings {
        println!(
            "natural {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    println!("natural verdict {:?}", rep.verdict);

    // ---- The declared fixture patch (see the module doc).
    let ctx = ctx_of(&a);
    let model_ring = adr(ctx.ring_seed(cq.heartland_max_ring as u16));
    let mut rs = r.c.account(&model_ring).expect("a real seeded RingSeed");
    assert_eq!(rs.data[RS::STATUS], RS::STATUS_SEEDED);
    rs.data[RS::D..RS::D + 2].copy_from_slice(&128u16.to_le_bytes());
    rs.data[RS::OPENED_BELL..RS::OPENED_BELL + 4].copy_from_slice(&0u32.to_le_bytes());
    r.c.set_account(adr(ctx.ring_seed(128)), rs)
        .expect("patch: RingSeed(128)");
    let mut fr = r.c.account(&a.frontier()).expect("frontier");
    for w in 0..6 {
        let o = FR::WEDGE_OPEN + 4 * w;
        let mut open = u32::from_le_bytes(fr.data[o..o + 4].try_into().unwrap());
        if open == 0 {
            open = 1;
            fr.data[o..o + 4].copy_from_slice(&open.to_le_bytes());
        }
        let oc = FR::WEDGE_OCCUPIED + 4 * w;
        fr.data[oc..oc + 4].copy_from_slice(&open.to_le_bytes());
    }
    r.c.set_account(a.frontier(), fr)
        .expect("patch: Frontier wedge counters");
    r.log.push("PATCH (set_account): RingSeed(128) seeded, opened_bell 0; Frontier wedge_occupied = wedge_open".into());
    // The wedge funds must cover ring 129 (real system transfers; not
    // program transactions, so not in the archive).
    let need = wl::ring_rent(129, frontier_abi::layout::rent(wl::province::SIZE) * 2).unwrap()
        + 10 * frontier_abi::layout::rent(wl::province::SIZE) * 2;
    for w in 0..6u8 {
        let f = adr(ctx.province_fund(w));
        let have = r.c.account(&f).map(|x| x.lamports).unwrap_or(0);
        if have < need {
            let t = solana_system_interface_transfer(&payer.pubkey(), &f, need - have);
            r.send(
                &[&payer],
                &[t],
                &format!("fund top-up wedge {w} (system transfer)"),
            );
        }
    }

    // ---- The witnessed segment.
    let seg_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    assert_eq!(seg_from, natural_len);
    r.snapshot = Some(BTreeMap::new());
    // A bell after ring 128's opened_bell 0; bound to a shipped round.
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
    let now = r.c.unix_timestamp();
    assert_eq!(
        ring_seed_round(&clock, now, margin),
        bound,
        "the request binds a shipped round (now {now})"
    );
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
    for (pp, qq) in OPENINGS {
        r.send(
            &[&payer],
            &[open_ix(&a, &payer.pubkey(), pp, qq)],
            &format!("WideOpenProvince({pp},{qq})"),
        );
    }
    // A second opening of the same province is refused (not judged).
    r.try_send(
        &[&payer],
        &[open_ix(&a, &payer.pubkey(), 129, 0)],
        "WideOpenProvince(129,0) again (refused)",
    );
    let snapshot = r.snapshot.take().unwrap();
    let (seg_txs, seg_finals) = r.archive(seg_from, &program);
    let seg_provenance = format!(
        "verify/tests/playable_wide_land.rs record_playable_wide_land: the witnessed wide land segment after the natural season and a declared set_account patch (RingSeed(128), Frontier wedge counters); bound round {bound}; steps: {}",
        r.log.join("; ")
    );
    let segment = input_of(
        program,
        so_hash,
        seg_txs,
        seg_finals,
        r.c.slot(),
        seg_provenance.clone(),
        "playable-wide-land-segment",
    );
    let snap = input_of(
        program,
        so_hash,
        vec![],
        snapshot,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the segment names, read before the segment's first transaction; {seg_provenance}"),
        "playable-wide-land-snapshot",
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
    if let Ok(dir) = std::env::var("PLAYABLE_WIDE_DUMP") {
        let d = std::path::Path::new(&dir);
        natural
            .save(&d.join("playable-wide-setrules.json.gz"))
            .expect("save");
        segment
            .save(&d.join("playable-wide-land-segment.json.gz"))
            .expect("save");
        snap.save(&d.join("playable-wide-land-snapshot.json.gz"))
            .expect("save");
        println!("saved to {dir}");
    }
    assert_eq!(
        rep.verdict,
        Verdict::Pass,
        "the natural season with WideSetRules"
    );
    assert!(found.is_empty(), "the honest segment");
}

/// A System program transfer (instruction 2, `lamports u64`).
fn solana_system_interface_transfer(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: fclient::addr::system_program(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

// ------------------------------------------------------------ the committed recordings

fn natural() -> Input {
    common::fixture("playable-wide-setrules.json.gz")
}

fn segment() -> (Input, BTreeMap<[u8; 32], Option<Account>>) {
    (
        common::fixture("playable-wide-land-segment.json.gz"),
        common::fixture("playable-wide-land-snapshot.json.gz").finals,
    )
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

/// The `n`th account of the first program instruction of transaction `t`.
fn ix_key(inp: &Input, t: usize, n: usize) -> [u8; 32] {
    let tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let keys = &tx.message.account_keys;
    let ci = tx
        .message
        .instructions
        .iter()
        .find(|c| keys[c.program_id_index as usize] == inp.cfg.program)
        .unwrap();
    keys[ci.accounts[n] as usize].to_bytes()
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

fn show(found: &[verify_core::Finding]) -> Vec<(String, String, String)> {
    found
        .iter()
        .map(|f| (f.check.to_string(), f.code.clone(), f.detail.clone()))
        .collect()
}

const T_REQ: u8 = wix::TAG_REQUEST_RING_SEED;
const T_CONSUME: u8 = wix::TAG_CONSUME_RING_SEED;
const T_OPEN: u8 = wix::TAG_OPEN_PROVINCE;
const T_RULES: u8 = wix::TAG_SET_RULES;

// ---- the natural season (whole history)

#[test]
fn the_natural_season_with_wide_set_rules_passes() {
    let inp = natural();
    assert_eq!(
        txs_with(&inp, T_RULES).len(),
        1,
        "one successful WideSetRules"
    );
    let rep = verify_core::verify(&inp);
    // (D-verify-pr89-3: its legacy OpenProvinces are VX's, and the ec511123…
    //  binary is not committed: no FAIL, and only those are open)
    assert_eq!(
        rep.verdict,
        Verdict::Unverifiable,
        "{:#?}",
        show(&rep.findings)
    );
    assert!(
        common::only_open_province_unexecuted(&rep),
        "{:#?}",
        show(&rep.findings)
    );
    assert!(
        rep.checks_run.contains(&"VWL:wide-land"),
        "{:?}",
        rep.checks_run
    );
    assert!(!rep.findings.iter().any(|f| f.code == "WideUnmodelled"));
}

#[test]
fn a_forged_rules_configuration_fails() {
    let mut inp = natural();
    let t = txs_with(&inp, T_RULES)[0];
    let k = ix_key(&inp, t, 2);
    edit_post(&mut inp, t, &k, |a| {
        a.data[wr::rules_config::KEEP_HOLDER] ^= 3
    });
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep.findings));
    assert!(
        has(&rep.findings, "WideReplayMismatch"),
        "{:#?}",
        show(&rep.findings)
    );
}

#[test]
fn rules_set_by_someone_other_than_the_season_authority_fail() {
    let mut inp = natural();
    // The Season's stored authority, as the archive shows it before the rules.
    let t = txs_with(&inp, T_RULES)[0];
    let season = ix_key(&inp, t, 1);
    let before = (0..t)
        .rev()
        .find(|&u| {
            inp.txs[u].err.is_none()
                && inp.txs[u]
                    .post
                    .iter()
                    .any(|(x, a)| x.to_bytes() == season && a.is_some())
        })
        .unwrap();
    edit_post(&mut inp, before, &season, |a| {
        a.data[frontier_abi::layout::world::season::AUTHORITY] ^= 1
    });
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(has(&rep.findings, "WideRule"), "{:#?}", show(&rep.findings));
}

#[test]
fn an_undecodable_wide_instruction_is_never_a_pass() {
    let mut inp = natural();
    let t = txs_with(&inp, T_RULES)[0];
    verify_core::tamper::edit_ix_tag(&mut inp, t, T_RULES, |d| d.push(0));
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep.findings));
}

#[test]
fn a_march_record_close_is_never_a_pass_and_no_longer_unmodelled() {
    // verifier-coverage-2: the march-record closes (WideClose what 2..=5)
    // are VX's (re-executed by the pinned program; the ticket, holding and
    // province closes are VWL's since `vwl_wide_close.rs`), and on the
    // devnet-playable binary what 2 (and 5) can never run: V0 `GateClosed`
    // when the archive pins that binary. Never a PASS, never `WideUnmodelled`.
    let mut inp = natural();
    let t = txs_with(&inp, T_RULES)[0];
    verify_core::tamper::edit_ix_tag(&mut inp, t, T_RULES, |d| {
        *d = wix::Close {
            what: wix::CLOSE_WHAT_SLOT,
        }
        .to_bytes()
        .to_vec()
    });
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, Verdict::Pass);
    assert!(
        !rep.findings
            .iter()
            .any(|f| f.code == "WideUnmodelled" && f.entity == format!("tx#{t}")),
        "{:#?}",
        show(&rep.findings)
    );
    let at_t: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.entity == format!("tx#{t}") && (f.check == "V0" || f.check == "VX"))
        .collect();
    assert!(!at_t.is_empty(), "{:#?}", show(&rep.findings));
    let pinned_devnet = inp.cfg.program_hash.is_some_and(|h| {
        verify_core::checks::v0_coverage::pinned_gate_closed(Some(h), &inp.program_hashes)
    });
    assert_eq!(
        pinned_devnet,
        rep.findings
            .iter()
            .any(|f| f.code == "GateClosed" && f.entity == format!("tx#{t}")),
        "{:#?}",
        show(&rep.findings)
    );
}

// ---- the witnessed segment

#[test]
fn the_honest_wide_land_segment_re_runs() {
    let (seg, snap) = segment();
    assert_eq!(txs_with(&seg, T_REQ).len(), 1);
    assert_eq!(txs_with(&seg, T_CONSUME).len(), 1);
    assert_eq!(txs_with(&seg, T_OPEN).len(), 6, "one province per wedge");
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
    // Every opening wrote a wide province VR now knows.
    for t in txs_with(&seg, T_OPEN) {
        let k = ix_key(&seg, t, 4);
        let a = seg.txs[t]
            .post
            .iter()
            .find(|(x, _)| x.to_bytes() == k)
            .unwrap()
            .1
            .as_ref()
            .unwrap();
        assert_eq!(&a.data[..8], &wl::province::MAGIC);
    }
}

#[test]
fn a_forged_ring_seed_request_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_REQ)[0];
    let k = ix_key(&seg, t, 4);
    edit_post(&mut seg, t, &k, |a| a.data[wl::ring_seed::ROUND] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_request_below_theta_fails() {
    let (seg, mut snap) = segment();
    let fr = snap
        .get_mut(&common_frontier(&seg))
        .unwrap()
        .as_mut()
        .unwrap();
    for w in 0..6 {
        let o = FR::WEDGE_OCCUPIED + 4 * w;
        fr.data[o..o + 4].copy_from_slice(&0u32.to_le_bytes());
    }
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_request_after_an_unseeded_ring_128_fails() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_REQ)[0];
    let k = ix_key(&seg, t, 3);
    snap.get_mut(&k).unwrap().as_mut().unwrap().data[RS::STATUS] = RS::STATUS_REQUESTED;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_request_from_an_underfunded_wedge_fails() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_REQ)[0];
    let k = ix_key(&seg, t, 7);
    snap.get_mut(&k).unwrap().as_mut().unwrap().lamports = 1_000_000;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_consumed_seed_that_is_not_the_beacons_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CONSUME)[0];
    let k = ix_key(&seg, t, 2);
    edit_post(&mut seg, t, &k, |a| a.data[wl::ring_seed::SEED] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_consume_with_a_forged_signature_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CONSUME)[0];
    // ring u64 ‖ round u64 ‖ sig48: flip a signature byte.
    verify_core::tamper::edit_ix_tag(&mut seg, t, T_CONSUME, |d| d[1 + 16 + 5] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "BeaconSigInvalid"), "{:#?}", show(&found));
}

#[test]
fn a_forged_wide_province_fails() {
    let (seg0, snap) = segment();
    let t = txs_with(&seg0, T_OPEN)[2];
    let k = ix_key(&seg0, t, 4);
    // A terrain byte, the funded lamports in the trailer, the opened bell.
    for off in [
        frontier_abi::layout::province::province::TERRAIN + 7,
        wl::province::FUNDED_LAMPORTS,
        frontier_abi::layout::province::province::RESOLVED_NEXT,
    ] {
        let mut seg = seg0.clone();
        edit_post(&mut seg, t, &k, |a| a.data[off] ^= 1);
        let found = vwl::judge_segment(&seg, &snap);
        assert!(
            has(&found, "WideReplayMismatch"),
            "offset {off}: {:#?}",
            show(&found)
        );
    }
}

#[test]
fn a_forged_fund_counter_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_OPEN)[0];
    let k = ix_key(&seg, t, 3);
    edit_post(&mut seg, t, &k, |a| {
        a.data[frontier_abi::layout::world::province_fund::OPEN_SITES] ^= 1
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn an_opening_without_a_configuration_fails() {
    let (seg, mut snap) = segment();
    let config = adr(wr::rules_config_address(&AddrCtx {
        program: seg.cfg.program.to_bytes(),
        season: findex::addr_ctx(&seg.cfg.program, seg.cfg.season_id).season,
    }))
    .to_bytes();
    snap.insert(config, None);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_wide_instruction_writing_an_account_it_never_writes_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CONSUME)[0];
    let fr = common_frontier(&seg);
    let mut a = snap.get(&fr).unwrap().clone().unwrap();
    a.data[FR::RINGS_OPENED] ^= 1;
    seg.txs[t].post.push((adr(fr), Some(a)));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_witness_without_the_season_is_unverifiable() {
    let (seg, mut snap) = segment();
    let season = findex::addr_ctx(&seg.cfg.program, seg.cfg.season_id).season;
    snap.remove(&season);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(!found.is_empty());
    assert!(
        found.iter().all(|f| f.code == "MissingData"),
        "{:#?}",
        show(&found)
    );
}

fn common_frontier(seg: &Input) -> [u8; 32] {
    let t = txs_with(seg, T_REQ)[0];
    ix_key(seg, t, 2)
}

#[test]
fn the_openings_exercise_the_keep_camp_and_free_city_paths() {
    use frontier_abi::layout::province::{camp as CP, province as PV};
    use frontier_abi::v2::layout::province::site as SM2;
    let (seg, _) = segment();
    let (mut camps, mut cities, mut keeps) = (0, 0, 0);
    for t in txs_with(&seg, T_OPEN) {
        let k = ix_key(&seg, t, 4);
        let d = &seg.txs[t]
            .post
            .iter()
            .find(|(x, _)| x.to_bytes() == k)
            .unwrap()
            .1
            .as_ref()
            .unwrap()
            .data;
        camps += (d[PV::CAMP + CP::STATE] == CP::STATE_PRESENT) as u32;
        cities += (0..PV::SITES_N)
            .filter(|&i| d[PV::site(i) + SM2::STATE] == SM2::STATE_FREE_CITY)
            .count() as u32;
        keeps += (d[frontier_abi::v2::layout::province::province::KEEP] != 0xFF) as u32;
    }
    println!("camps {camps} free cities {cities} keeps {keeps}");
    assert!(
        keeps > 0 && camps > 0 && cities > 0,
        "a keep, a camp and a Free City were opened"
    );
}

// ---- round 2 of #72 (verify-pr72 B-1): lamports of the #67 handlers

#[test]
fn a_consume_that_drains_the_ring_seed_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CONSUME)[0];
    let k = ix_key(&seg, t, 2);
    edit_post(&mut seg, t, &k, |a| a.lamports -= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(has(&found, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn an_opening_that_drains_the_ring_seed_or_the_province_fails() {
    let (mut seg, snap) = segment();
    let opens = txs_with(&seg, T_OPEN);
    let k = ix_key(&seg, opens[0], 2);
    edit_post(&mut seg, opens[0], &k, |a| a.lamports -= 1);
    let p = ix_key(&seg, opens[1], 4);
    edit_post(&mut seg, opens[1], &p, |a| a.lamports -= 1);
    let found = vwl::judge_segment(&seg, &snap);
    for t in [opens[0], opens[1]] {
        assert!(
            found
                .iter()
                .any(|f| f.code == "WideReplayMismatch" && f.entity == format!("tx#{t}")),
            "{:#?}",
            show(&found)
        );
    }
}

// ---- round 3 (verify-pr72 B-2): a real archive also holds wallets

/// As the real archive (the localnet feed, `input::written_keys`) does:
/// every writable account's post and final, the fee payer's wallet
/// included (the committed fixtures keep program-owned accounts only).
fn with_wallet_posts(inp: &mut Input, snap: &mut BTreeMap<[u8; 32], Option<Account>>) {
    let system = Address::new_from_array([0; 32]);
    let wallet = |lamports: u64| Account {
        lamports,
        data: vec![],
        owner: system,
        executable: false,
    };
    let mut bal: BTreeMap<[u8; 32], u64> = BTreeMap::new();
    for t in 0..inp.txs.len() {
        let p = fclient::tx::from_wire(&inp.txs[t].tx)
            .unwrap()
            .message
            .account_keys[0]
            .to_bytes();
        let b = *bal.entry(p).or_insert_with(|| {
            snap.insert(p, Some(wallet(1_000_000_000_000)));
            1_000_000_000_000
        });
        let after = b - 5_000 - 3_000_000; // the fee and some rent paid
        bal.insert(p, after);
        inp.txs[t]
            .post
            .push((Address::new_from_array(p), Some(wallet(after))));
    }
    for (k, l) in bal {
        inp.finals.insert(k, Some(wallet(l)));
    }
}

#[test]
fn the_honest_land_with_wallet_posts_still_re_runs() {
    let (mut seg, mut snap) = segment();
    with_wallet_posts(&mut seg, &mut snap);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}
