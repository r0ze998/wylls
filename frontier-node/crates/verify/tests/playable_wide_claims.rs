//! VWL part 2: the WIDE CLAIMS of the PLAYABLE lane (0x4804) under the
//! verifier's `playable-lane` feature (Q16-1 = A continued, 2026-11-19).
//!
//! One recording of the deployed devnet-playable `.so` (sha256 45f012f2…)
//! in the in-process LiteSVM chain (`localnet::Chain`), made by
//! `record_playable_wide_claims` (ignored; needs the artefact):
//! `playable-wide-claims-segment.json.gz` + `…-snapshot.json.gz`, a
//! witnessed segment judged by `vwl_wide_land::judge_segment`.
//!
//! How the chain gets there:
//!
//! 1. A REAL season by its own instructions (as `playable_wide_land.rs`):
//!    AnnounceSeason … OpenRing, an OpenProvince per nation needed, three
//!    players' real Join + PlaceHome, the authority's WideSetRules.
//! 2. The wide land as `playable_wide_land.rs` makes it: a **declared
//!    patch** (`Chain::set_account`) of the legacy RingSeed(128) and the
//!    Frontier's wedge counters, then the REAL WideRequestRingSeed(129),
//!    WideConsumeRingSeed (a shipped quicknet round) and WideOpenProvince.
//! 3. A second **declared patch**, of what no natural season of this build
//!    can reach offline (`playable_wide_land.rs` D-1; claims need a FINAL
//!    TOWN first home within `outpost_range` of ring 129 and THE anchor's
//!    seed of the ticket bell, whose drand rounds the workspace does not
//!    ship): for each player its PlaceHome-written Holding copied to a
//!    site of the rim province (128, 0) with the tier raised to Town and
//!    stores filled, a v2 Province at (128, 0) (a copy of a real one with
//!    its coordinate and mirror set), the Citizen's slot 1 re-pointed there
//!    (what `wide_land_runtime_tests::fixture_rim_home` does on the host);
//!    and, before each settle, THE anchor and the SeedCache of the ticket
//!    bell and the province's region with a literal seed, in the shapes
//!    PostAnchor and PostSeed leave (`wide_land_runtime_tests::stage_seed`).
//! 4. Then everything is REAL and is the segment: three WideClaimSite
//!    (two on one site in one bell), WideSettleTicket fresh then displace,
//!    an expired settle 24 bells later, WideFinalize, two refiles (one
//!    topping up the escrow, one over the retained escrow) and their fresh
//!    settles, and slot-3 claims over a wide slot-2 holding (one final, one
//!    due and flipped by the claim).
//!
//! The snapshot holds the state, before its first use in the segment, of
//! every account a segment instruction names (an execution witness; the
//! staged anchors and caches are in it as the patch left them). A season
//! verdict of such a world is not claimed: the patches are not
//! instructions.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_WIDE_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_wide_claims -- --ignored --nocapture`
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
    holding as wh,
    land::{self as wl, WideProvince},
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    ticket as wt, wide_ix as wix, WideCoord,
};
use permutation_rules::frontier::beacon::{
    self as kb, genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time,
    BeaconClock, WindowSchedule,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use verify_core::checks::vwl_wide_land as vwl;
use verify_core::input::{Config, Input};

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
const PLAYABLE_SHA256: &str = "45f012f21b179ca07808ebb3174fa50d4f30ecd68c39f840c78c98a9ad622dcd";
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
    shard: u8,
    citizen: [u8; 32],
    tag: u64,
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

fn finalize_ix(a: &Addresses, any: &Address, coord: WideCoord, site: u8) -> Instruction {
    let c = ctx_of(a);
    wide_ix(
        a,
        vec![
            AccountMeta::new_readonly(*any, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wh::holding_address(&c, coord, site)), false),
            AccountMeta::new_readonly(adr(wl::province_address(&c, coord)), false),
        ],
        wix::Finalize.to_bytes().to_vec(),
    )
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

fn le64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

#[test]
#[ignore = "needs the devnet-playable .so: set PSF_PLAYABLE_SO (sha256 45f012f2…), run with --ignored"]
fn record_playable_wide_claims() {
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
            tag: le64(&cd, C::CITIZEN_TAG),
            rim_site: i as u8,
        });
    }
    r.send(
        &[&upgrade],
        &[set_rules_ix(&a, &upgrade.pubkey())],
        "WideSetRules",
    );

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

    // ---- 4. The witnessed claims segment.
    let seg_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    r.snapshot = Some(BTreeMap::new());
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
    // A free site of p0 other than the Free City.
    let free_sites = |r: &Rec, coord: WideCoord| -> Vec<u8> {
        let d = r.data(&adr(wl::province_address(&ctx, coord))).unwrap();
        (0..d[PV::SITE_COUNT])
            .filter(|&s| {
                let o = PV::site(s as usize);
                d[o + SM::STATE] == SM::STATE_FREE
                    && d[frontier_abi::v2::layout::province::province::record(s as usize)
                        ..frontier_abi::v2::layout::province::province::record(s as usize) + 32]
                        .iter()
                        .all(|b| *b == 0)
            })
            .collect()
    };
    let sites0 = free_sites(&r, p0);
    assert!(sites0.len() >= 4, "free sites of {p0:?}: {sites0:?}");
    let (s_a, s_c, s_ref1, s_ref2) = (sites0[0], sites0[1], sites0[2], sites0[3]);
    let b0 = bell_now(&r);
    for (i, s) in [(0usize, s_a), (1, s_a), (2, s_c)] {
        r.send(
            &[&members[i].wallet],
            &[claim_ix(&a, &members[i], p0, s, 2, None)],
            &format!("WideClaimSite player {i} ({p0:?}, site {s}) slot 2"),
        );
    }
    assert_eq!(bell_now(&r), b0, "the three filings share one bell");
    let seed0 = [0x5Au8; 32];
    let final0 = stage_seed(&mut r, b0, reg0, seed0);
    // Settle the lower score of A/B first (fresh), then the higher
    // (displace).
    let score = |m: &Member, s: u8| wt::wide_ticket_score(&seed0, p0, s, m.tag);
    let (lo, hi) = if score(&members[0], s_a) < score(&members[1], s_a) {
        (0, 1)
    } else {
        (1, 0)
    };
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[lo],
            p0,
            s_a,
            b0,
            reg0,
            None,
        )],
        &format!("WideSettleTicket player {lo} (fresh)"),
    );
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[hi],
            p0,
            s_a,
            b0,
            reg0,
            Some((members[lo].wallet.pubkey(), &members[lo])),
        )],
        &format!("WideSettleTicket player {hi} (displaces player {lo})"),
    );
    // Player 2's ticket expires 24 bells later.
    let g = genesis_ts;
    r.advance_to(g + 600 * (b0 as i64 + 24) + 5);
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[2],
            p0,
            s_c,
            b0,
            reg0,
            None,
        )],
        "WideSettleTicket player 2 (expired)",
    );
    assert!(r.c.unix_timestamp() >= final0);
    r.send(
        &[&payer],
        &[finalize_ix(&a, &payer.pubkey(), p0, s_a)],
        "WideFinalize (the winner's slot-2 holding)",
    );
    // Refiles: the displaced player (escrow consumed: tops up) and the
    // expired one (escrow retained: no top-up), both slot 2 again.
    let b1 = bell_now(&r);
    r.send(
        &[&members[lo].wallet],
        &[claim_ix(&a, &members[lo], p0, s_ref1, 2, None)],
        &format!("WideClaimSite player {lo} refile (site {s_ref1})"),
    );
    r.send(
        &[&members[2].wallet],
        &[claim_ix(&a, &members[2], p0, s_ref2, 2, None)],
        &format!("WideClaimSite player 2 refile (site {s_ref2})"),
    );
    let seed1 = [0x6Bu8; 32];
    let final1 = stage_seed(&mut r, b1, reg0, seed1);
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[lo],
            p0,
            s_ref1,
            b1,
            reg0,
            None,
        )],
        &format!("WideSettleTicket player {lo} (fresh)"),
    );
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[2],
            p0,
            s_ref2,
            b1,
            reg0,
            None,
        )],
        "WideSettleTicket player 2 (fresh)",
    );
    // Slot 3 in the neighbouring wide province: over a FINAL slot 2 (the
    // winner) and over a provisional slot 2 that is DUE (flipped by the
    // claim).
    r.advance_to(final1.max(r.c.unix_timestamp()) + 5);
    let sites1 = free_sites(&r, p1);
    assert!(sites1.len() >= 2, "free sites of {p1:?}: {sites1:?}");
    let b2 = bell_now(&r);
    r.send(
        &[&members[hi].wallet],
        &[claim_ix(
            &a,
            &members[hi],
            p1,
            sites1[0],
            3,
            Some((p0, s_a)),
        )],
        &format!("WideClaimSite player {hi} slot 3 over a final slot 2"),
    );
    r.send(
        &[&members[lo].wallet],
        &[claim_ix(
            &a,
            &members[lo],
            p1,
            sites1[1],
            3,
            Some((p0, s_ref1)),
        )],
        &format!("WideClaimSite player {lo} slot 3 over a due slot 2 (flip)"),
    );
    let reg1 = region_of(&r, p1);
    let seed2 = [0x7Cu8; 32];
    stage_seed(&mut r, b2, reg1, seed2);
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[hi],
            p1,
            sites1[0],
            b2,
            reg1,
            None,
        )],
        &format!("WideSettleTicket player {hi} slot 3 (fresh)"),
    );
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[lo],
            p1,
            sites1[1],
            b2,
            reg1,
            None,
        )],
        &format!("WideSettleTicket player {lo} slot 3 (fresh)"),
    );
    // Honest refusals (archived, not judged): a second settle, a finalize
    // of a final holding.
    r.try_send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[hi],
            p1,
            sites1[0],
            b2,
            reg1,
            None,
        )],
        "WideSettleTicket again (refused)",
    );
    r.try_send(
        &[&payer],
        &[finalize_ix(&a, &payer.pubkey(), p0, s_a)],
        "WideFinalize again (refused)",
    );

    let snapshot = r.snapshot.take().unwrap();
    let (seg_txs, seg_finals) = r.archive(seg_from, &program);
    let prov = format!(
        "verify/tests/playable_wide_claims.rs record_playable_wide_claims: the devnet-playable .so (sha256 {PLAYABLE_SHA256}) in localnet::Chain (LiteSVM, in process); a real season by its own instructions, the declared wide land patch (RingSeed(128), Frontier wedge counters) and the real ring-129 opening, then a declared claims patch (three players' PlaceHome holdings copied to the rim (128,0) as final Towns with stores, a v2 Province there, the Citizens' slot 1 re-pointed; THE anchor and SeedCache of each ticket bell with a literal seed) and the witnessed claims segment; steps: {}",
        r.log.join("; ")
    );
    let segment = input_of(
        program,
        so_hash,
        seg_txs,
        seg_finals,
        r.c.slot(),
        prov.clone(),
        "playable-wide-claims-segment",
    );
    let snap = input_of(
        program,
        so_hash,
        vec![],
        snapshot,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the segment names, read before its first use; {prov}"),
        "playable-wide-claims-snapshot",
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
    // The whole archive from genesis (patches included as discontinuities),
    // for the season-mode wiring test.
    let (all_txs, all_finals) = r.archive(0, &program);
    let whole = input_of(
        program,
        so_hash,
        all_txs,
        all_finals,
        r.c.slot(),
        format!("the whole archive from AnnounceSeason on, the two declared patches showing as state the archive never saw an instruction write; {prov}"),
        "playable-wide-claims-whole",
    );
    if let Ok(dir) = std::env::var("PLAYABLE_WIDE_DUMP") {
        let d = std::path::Path::new(&dir);
        whole
            .save(&d.join("playable-wide-claims-whole.json.gz"))
            .expect("save");
        segment
            .save(&d.join("playable-wide-claims-segment.json.gz"))
            .expect("save");
        snap.save(&d.join("playable-wide-claims-snapshot.json.gz"))
            .expect("save");
        println!("saved to {dir}");
    }
    assert!(found.is_empty(), "the honest claims segment");
}

// ------------------------------------------------------------ the committed recording

fn segment() -> (Input, BTreeMap<[u8; 32], Option<Account>>) {
    (
        common::fixture("playable-wide-claims-segment.json.gz"),
        common::fixture("playable-wide-claims-snapshot.json.gz").finals,
    )
}

/// The successful transactions whose program instruction has tag `tag`.
fn txs_with(inp: &Input, tag: u8) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none()
                && first_ix(inp, t).is_some_and(|(d, _)| d.first() == Some(&tag))
        })
        .collect()
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

fn ix_key(inp: &Input, t: usize, n: usize) -> [u8; 32] {
    first_ix(inp, t).unwrap().1[n]
}

fn post_of<'a>(inp: &'a Input, t: usize, k: &[u8; 32]) -> &'a Account {
    inp.txs[t]
        .post
        .iter()
        .find(|(x, _)| x.to_bytes() == *k)
        .and_then(|(_, a)| a.as_ref())
        .expect("a post-state")
}

/// The state of `k` before transaction `t`: the last post-state before
/// it, else the witness's.
fn before_of(
    inp: &Input,
    snap: &BTreeMap<[u8; 32], Option<Account>>,
    t: usize,
    k: &[u8; 32],
) -> Account {
    (0..t)
        .rev()
        .filter(|&u| inp.txs[u].err.is_none())
        .find_map(|u| {
            inp.txs[u]
                .post
                .iter()
                .find(|(x, _)| x.to_bytes() == *k)
                .and_then(|(_, a)| a.clone())
        })
        .or_else(|| snap.get(k).cloned().flatten())
        .expect("a state before")
}

fn edit_post(inp: &mut Input, t: usize, k: &[u8; 32], f: impl FnOnce(&mut Account)) {
    let (_, a) = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x.to_bytes() == *k)
        .expect("a post-state");
    f(a.as_mut().expect("present"));
}

fn witness<'a>(snap: &'a mut BTreeMap<[u8; 32], Option<Account>>, k: &[u8; 32]) -> &'a mut Account {
    snap.get_mut(k)
        .and_then(|a| a.as_mut())
        .expect("a witnessed state")
}

/// Findings of VWL at transaction `t` with `code`.
fn at(found: &[verify_core::Finding], t: usize, code: &str) -> bool {
    found
        .iter()
        .any(|f| f.check == "VWL" && f.code == code && f.entity == format!("tx#{t}"))
}

fn show(found: &[verify_core::Finding]) -> Vec<(String, String, String)> {
    found
        .iter()
        .map(|f| (f.entity.clone(), f.code.clone(), f.detail.clone()))
        .collect()
}

const T_CLAIM: u8 = wix::TAG_CLAIM_SITE;
const T_SETTLE: u8 = wix::TAG_SETTLE_TICKET;
const T_FINALIZE: u8 = wix::TAG_FINALIZE;

/// The settle that displaced a holding (13 accounts).
fn displacing(seg: &Input) -> usize {
    txs_with(seg, T_SETTLE)
        .into_iter()
        .find(|&t| first_ix(seg, t).unwrap().1.len() == 13)
        .expect("a displacement")
}

/// The settle that wrote no holding (the expired ticket).
fn expiring(seg: &Input) -> usize {
    txs_with(seg, T_SETTLE)
        .into_iter()
        .find(|&t| {
            let h = ix_key(seg, t, 4);
            !seg.txs[t].post.iter().any(|(x, _)| x.to_bytes() == h)
        })
        .expect("an expired settle")
}

#[test]
fn the_honest_claims_segment_re_runs() {
    let (seg, snap) = segment();
    assert_eq!(txs_with(&seg, T_CLAIM).len(), 7, "seven filings");
    assert_eq!(txs_with(&seg, T_SETTLE).len(), 7, "seven settles");
    assert_eq!(txs_with(&seg, T_FINALIZE).len(), 1, "one finality");
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}

#[test]
fn the_segment_exercises_every_claim_path() {
    let (seg, snap) = segment();
    // fresh, displace, expired, refile (top-up and retained), slot 3 over
    // a final and over a due slot 2 (the claim writes the slot-2 holding).
    displacing(&seg);
    expiring(&seg);
    let claims = txs_with(&seg, T_CLAIM);
    let slot = |t: usize| first_ix(&seg, t).unwrap().0[wix::ClaimSite::LEN - 1];
    let flips: Vec<usize> = claims
        .iter()
        .copied()
        .filter(|&t| slot(t) == 3)
        .filter(|&t| {
            let k = ix_key(&seg, t, 9);
            before_of(&seg, &snap, t, &k).data[H::STATE] != post_of(&seg, t, &k).data[H::STATE]
        })
        .collect();
    assert_eq!(flips.len(), 1, "one slot-3 claim flips a due slot 2");
    let refiles = claims
        .iter()
        .filter(|&&t| {
            let k = ix_key(&seg, t, 6);
            (0..t).any(|u| {
                seg.txs[u].err.is_none() && seg.txs[u].post.iter().any(|(x, _)| x.to_bytes() == k)
            })
        })
        .count();
    assert!(refiles >= 2, "refiles over a Settled record");
}

// ---- WideClaimSite

#[test]
fn a_forged_ticket_record_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let k = ix_key(&seg, t, 6);
    edit_post(&mut seg, t, &k, |a| a.data[wt::wide_ticket::SITE] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_claim_that_did_not_pay_the_settler_cost_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let k = ix_key(&seg, t, 7);
    // The anchor's first store as it was before (no cost paid).
    let before = snap[&k].as_ref().unwrap().data.clone();
    let o = H::store(0) + AC::VALUE;
    edit_post(&mut seg, t, &k, |a| {
        a.data[o..o + 8].copy_from_slice(&before[o..o + 8])
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_claim_from_a_provisional_first_home_fails() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    witness(&mut snap, &ix_key(&seg, t, 7)).data[H::STATE] = H::STATE_PROVISIONAL;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_claim_from_a_hamlet_first_home_fails() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    witness(&mut snap, &ix_key(&seg, t, 7)).data[H::TIER] = Tier::Hamlet as u8;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_claim_whose_anchor_is_not_the_first_home_fails() {
    // The Citizen's slot 1 names another home than the anchor listed.
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let o = C2::holding_of_slot(1);
    witness(&mut snap, &ix_key(&seg, t, 3)).data[o + HR::P..o + HR::P + 2]
        .copy_from_slice(&2i16.to_le_bytes());
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideAccounts"), "{:#?}", show(&found));
}

#[test]
fn a_claim_the_outpost_rule_refuses_fails() {
    // The Season's conquest block with an outpost share of 0 bps: no
    // faction share is below it, so `may_found_outpost` refuses.
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let s = ix_key(&seg, t, 2);
    use frontier_abi::v2::layout::world::season as S2;
    let o = S2::CONQUEST_PARAMS + frontier_abi::v2::presets::cq_layout::OUTPOST_SHARE_BPS;
    witness(&mut snap, &s).data[o..o + 2].copy_from_slice(&0u16.to_le_bytes());
    let found = vwl::judge_segment(&seg, &snap);
    assert!(
        found.iter().any(|f| f.entity == format!("tx#{t}")
            && f.code == "WideRule"
            && f.detail.contains("outpost rule")),
        "{:#?}",
        show(&found)
    );
}

#[test]
fn a_forged_cohort_or_marker_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[1];
    let prov = ix_key(&seg, t, 5);
    edit_post(&mut seg, t, &prov, |a| a.data[PV::cohort(0) + 4] ^= 1);
    let u = txs_with(&seg, T_CLAIM)[2];
    let cit = ix_key(&seg, u, 3);
    edit_post(&mut seg, u, &cit, |a| a.data[C::TICKET_BELL] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
    assert!(at(&found, u, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_second_pending_ticket_fails() {
    // The witness shows the record Open: the program refuses TicketState.
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let k = ix_key(&seg, t, 6);
    // The record as the claim itself left it (Open) shown before it.
    let open = post_of(&seg, t, &k).clone();
    snap.insert(k, Some(open));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_flip_the_claim_did_not_owe_fails() {
    // A slot-3 claim over a FINAL slot 2 that also rewrites it.
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)
        .into_iter()
        .find(|&t| {
            let k = ix_key(&seg, t, 9);
            first_ix(&seg, t).unwrap().0[wix::ClaimSite::LEN - 1] == 3
                && before_of(&seg, &snap, t, &k).data[H::STATE] == H::STATE_FINAL
        })
        .expect("a slot-3 claim over a final slot 2");
    let k = ix_key(&seg, t, 9);
    edit_post(&mut seg, t, &k, |a| a.data[H::TICKET_SCORE] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

// ---- WideSettleTicket

#[test]
fn a_forged_ticket_score_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    let h = ix_key(&seg, t, 4);
    edit_post(&mut seg, t, &h, |a| a.data[H::TICKET_SCORE] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_settle_over_a_seed_that_is_not_the_anchors_fails() {
    // Another seed in THE anchor's cache: the score the holding carries
    // is not the cache's.
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    witness(&mut snap, &ix_key(&seg, t, 7)).data[SC::SEED] ^= 1;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_seed_cache_of_another_round_fails() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    witness(&mut snap, &ix_key(&seg, t, 7)).data[SC::ROUND] ^= 1;
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideAccounts"), "{:#?}", show(&found));
}

#[test]
fn a_displacement_by_the_worse_ticket_fails() {
    // The held provisional holding's score above the challenger's: the
    // program would have called it taken (10 accounts), not displaced.
    let (seg, snap) = segment();
    let t = displacing(&seg);
    let h = ix_key(&seg, t, 4);
    // The holding as the fresh settle before it wrote it.
    let u = (0..t)
        .rev()
        .find(|&u| seg.txs[u].post.iter().any(|(x, _)| x.to_bytes() == h))
        .unwrap();
    let mut seg = seg;
    edit_post(&mut seg, u, &h, |a| {
        a.data[H::TICKET_SCORE..H::TICKET_SCORE + 8].copy_from_slice(&u64::MAX.to_le_bytes())
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "Undecodable"), "{:#?}", show(&found));
}

#[test]
fn a_displaced_citizen_left_bound_fails() {
    let (mut seg, snap) = segment();
    let t = displacing(&seg);
    let dc = ix_key(&seg, t, 10);
    let o = C2::holding_of_slot(2);
    // The loser's slot 2 as before the displacement (still bound).
    let before = (0..t)
        .rev()
        .find_map(|u| {
            seg.txs[u]
                .post
                .iter()
                .find(|(x, _)| x.to_bytes() == dc)
                .and_then(|(_, a)| a.clone())
        })
        .unwrap();
    edit_post(&mut seg, t, &dc, |a| {
        a.data[o..o + HR::SIZE].copy_from_slice(&before.data[o..o + HR::SIZE])
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn an_expired_ticket_that_kept_no_escrow_fails() {
    let (mut seg, snap) = segment();
    let t = expiring(&seg);
    let rec = ix_key(&seg, t, 3);
    edit_post(&mut seg, t, &rec, |a| a.data[wt::wide_ticket::ESCROW] ^= 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_win_that_took_more_than_one_rent_fails() {
    // The record lost more than the one wide rent the win moves (more
    // lamports than the re-run would only be unknown: a system transfer
    // may have reached it outside the archive).
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    let rec = ix_key(&seg, t, 3);
    let l = post_of(&seg, t, &rec).lamports;
    edit_post(&mut seg, t, &rec, |a| a.lamports = l - 1_000);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_settle_without_the_anchor_in_the_witness_is_unverifiable() {
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    snap.remove(&ix_key(&seg, t, 8));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "MissingData"), "{:#?}", show(&found));
    assert!(
        !found
            .iter()
            .any(|f| f.entity == format!("tx#{t}") && f.severity == verify_core::Severity::Fail),
        "{:#?}",
        show(&found)
    );
}

// ---- WideFinalize

#[test]
fn a_finality_before_its_time_fails() {
    let (seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    // The holding's final_ts never reached.
    let mut seg = seg;
    let h = ix_key(&seg, t, 2);
    let u = (0..t)
        .rev()
        .find(|&u| seg.txs[u].post.iter().any(|(x, _)| x.to_bytes() == h))
        .unwrap();
    edit_post(&mut seg, u, &h, |a| {
        a.data[H::FINAL_TS..H::FINAL_TS + 8].copy_from_slice(&i64::MAX.to_le_bytes())
    });
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_finality_that_writes_more_than_the_state_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    let h = ix_key(&seg, t, 2);
    edit_post(&mut seg, t, &h, |a| a.data[H::TIER] = Tier::Town as u8);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_finality_of_a_final_holding_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    let h = ix_key(&seg, t, 2);
    let u = (0..t)
        .rev()
        .find(|&u| seg.txs[u].post.iter().any(|(x, _)| x.to_bytes() == h))
        .unwrap();
    edit_post(&mut seg, u, &h, |a| a.data[H::STATE] = H::STATE_FINAL);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideRule"), "{:#?}", show(&found));
}

#[test]
fn a_wide_claim_writing_an_account_it_never_writes_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    // The province (read-only for WideFinalize) rewritten.
    let p = ix_key(&seg, t, 3);
    let u = (0..t)
        .rev()
        .find_map(|u| {
            seg.txs[u]
                .post
                .iter()
                .find(|(x, _)| x.to_bytes() == p)
                .and_then(|(_, a)| a.clone())
        })
        .unwrap();
    let mut forged = u.clone();
    forged.data[PV::ROSTER_EPOCH] ^= 1;
    seg.txs[t]
        .post
        .push((Address::new_from_array(p), Some(forged)));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

// ---- season mode: the whole archive

fn whole() -> Input {
    common::fixture("playable-wide-claims-whole.json.gz")
}

/// Every account the declared patches wrote (module doc), as the
/// segment's instructions name them.
fn patched(seg: &Input) -> std::collections::BTreeSet<[u8; 32]> {
    let mut out = std::collections::BTreeSet::new();
    let ctx = AddrCtx {
        program: seg.cfg.program.to_bytes(),
        season: ix_key(seg, txs_with(seg, T_CLAIM)[0], 2),
    };
    out.insert(ctx.ring_seed(128));
    for t in txs_with(seg, T_CLAIM) {
        for n in [3, 4, 7, 8] {
            out.insert(ix_key(seg, t, n));
        }
    }
    for t in txs_with(seg, T_SETTLE) {
        for n in [7, 8] {
            out.insert(ix_key(seg, t, n));
        }
    }
    out
}

#[test]
fn season_mode_judges_the_claims_and_only_the_patches_break_the_season() {
    // The whole archive from genesis: the claims are judged by VWL (no
    // WideUnmodelled, no unknown layout, V7 leaves the anchor to VWL), and
    // every FAIL is the declared patch showing (state the archive never
    // saw an instruction write), never an honest instruction's.
    let inp = whole();
    let (seg, _) = segment();
    let patch = patched(&seg);
    let rep = verify_core::verify(&inp);
    assert!(
        rep.checks_run.contains(&"VWL:wide-land"),
        "{:?}",
        rep.checks_run
    );
    assert!(
        !rep.findings
            .iter()
            .any(|f| f.code == "WideUnmodelled" || f.code == "UnknownAccount"),
        "{:#?}",
        show(&rep.findings)
    );
    let claims: Vec<usize> = txs_with(&inp, T_CLAIM);
    let first_three = &claims[..3];
    for f in rep
        .findings
        .iter()
        .filter(|f| f.severity == verify_core::Severity::Fail)
    {
        let on_patch = patch
            .iter()
            .any(|k| f.entity.contains(&Address::new_from_array(*k).to_string()));
        let citizen_patch = f.check == "VWL"
            && f.code == "WideAccounts"
            && f.detail.contains("first home's address")
            && first_three.iter().any(|t| f.entity == format!("tx#{t}"));
        assert!(
            (f.check == "CQ1" && on_patch) || citizen_patch,
            "a FAIL the patches do not explain: {} {} {} {}",
            f.check,
            f.code,
            f.entity,
            f.detail
        );
    }
    // Every later claim, settle and finality re-ran: its only possible
    // finding is MissingData (a patched account with no archived state).
    for t in txs_with(&inp, T_CLAIM)
        .into_iter()
        .skip(3)
        .chain(txs_with(&inp, T_SETTLE))
        .chain(txs_with(&inp, T_FINALIZE))
    {
        for f in rep
            .findings
            .iter()
            .filter(|f| f.check == "VWL" && f.entity == format!("tx#{t}"))
        {
            assert_eq!(f.code, "MissingData", "{} {}", f.entity, f.detail);
        }
    }
    assert!(
        !rep.findings.iter().any(
            |f| f.check == "VWL" && f.entity == format!("tx#{}", txs_with(&inp, T_FINALIZE)[0])
        ),
        "the finality re-ran from archived states with no finding"
    );
}

// ---- round 2 (verify-pr72 B-1): the FULL post-state, lamports included

/// Drains `n` lamports from account `pos` of transaction `t`, data kept.
fn drain(seg: &mut Input, t: usize, pos: usize, n: u64) -> [u8; 32] {
    let k = ix_key(seg, t, pos);
    edit_post(seg, t, &k, |a| a.lamports -= n);
    k
}

#[test]
fn a_claim_that_drains_its_anchor_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    drain(&mut seg, t, 7, 1_000_000);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_claim_that_drains_the_citizen_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[1];
    drain(&mut seg, t, 3, 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_settle_that_drains_the_wide_province_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    drain(&mut seg, t, 5, 1_000_000);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_settle_that_drains_the_join_shard_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_SETTLE)[0];
    drain(&mut seg, t, 6, 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_displacement_that_drains_the_displaced_citizen_fails() {
    let (mut seg, snap) = segment();
    let u = displacing(&seg);
    drain(&mut seg, u, 10, 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, u, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn an_expired_settle_that_drains_its_holding_slot_fails() {
    // The expired settle writes no holding; its record keeps its lamports.
    let (mut seg, snap) = segment();
    let t = expiring(&seg);
    drain(&mut seg, t, 3, 1);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_finality_that_drains_the_holding_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    drain(&mut seg, t, 2, 1_000_000);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_gift_to_a_handlers_account_is_unverifiable_not_a_pass() {
    // More lamports than before on an account the handler never debits:
    // a system transfer the archive cannot show. Never PASS, never FAIL.
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    let k = ix_key(&seg, t, 2);
    edit_post(&mut seg, t, &k, |a| a.lamports += 5);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "MissingData"), "{:#?}", show(&found));
    assert!(!at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn an_executable_post_state_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    let k = ix_key(&seg, t, 5);
    edit_post(&mut seg, t, &k, |a| a.executable = true);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn a_post_state_of_an_account_the_instruction_does_not_list_fails() {
    let (mut seg, snap) = segment();
    let t = txs_with(&seg, T_FINALIZE)[0];
    // Another claim's ticket record, unchanged data, appears in its post.
    let other = ix_key(&seg, txs_with(&seg, T_CLAIM)[0], 6);
    let a = before_of(&seg, &snap, t, &other);
    seg.txs[t]
        .post
        .push((Address::new_from_array(other), Some(a)));
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
}

#[test]
fn season_mode_a_drained_finality_fails() {
    // verify-pr72's season probe: the drain in the whole archive, the final
    // kept consistent with the last archived write.
    let mut inp = whole();
    let t = txs_with(&inp, T_FINALIZE)[0];
    let h = ix_key(&inp, t, 2);
    edit_post(&mut inp, t, &h, |a| a.lamports -= 1_000_000);
    let last = (0..inp.txs.len())
        .rev()
        .find(|&u| {
            inp.txs[u]
                .post
                .iter()
                .any(|(x, a)| x.to_bytes() == h && a.is_some())
        })
        .unwrap();
    let l = post_of(&inp, last, &h).lamports;
    if let Some(Some(a)) = inp.finals.get_mut(&h) {
        a.lamports = l;
    }
    let rep = verify_core::verify(&inp);
    assert!(
        rep.findings.iter().any(|f| f.check == "VWL"
            && f.code == "WideReplayMismatch"
            && f.entity == format!("tx#{t}")
            && f.severity == verify_core::Severity::Fail),
        "{:#?}",
        show(&rep.findings)
    );
}

#[test]
fn a_final_handed_to_another_owner_fails() {
    // CQ1 (D-verify-pr72-2): the final state of an account whose last
    // archived write was the program's, now owned by someone else.
    let mut inp = whole();
    let (seg, _) = segment();
    let k = ix_key(&seg, txs_with(&seg, T_CLAIM)[0], 6);
    let a = inp.finals.get_mut(&k).unwrap().as_mut().unwrap();
    a.lamports += 1;
    a.owner = Address::new_from_array([7; 32]);
    let rep = verify_core::verify(&inp);
    assert!(
        rep.findings.iter().any(|f| f.check == "CQ1"
            && f.severity == verify_core::Severity::Fail
            && f.entity == Address::new_from_array(k).to_string()),
        "{:#?}",
        show(&rep.findings)
    );
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
fn the_honest_claims_with_wallet_posts_still_re_run() {
    let (mut seg, mut snap) = segment();
    with_wallet_posts(&mut seg, &mut snap);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(found.is_empty(), "{:#?}", show(&found));
}

#[test]
fn wallet_posts_and_finals_add_no_finding_to_the_whole_archive() {
    let rep0 = verify_core::verify(&whole());
    let mut inp = whole();
    with_wallet_posts(&mut inp, &mut BTreeMap::new());
    let rep = verify_core::verify(&inp);
    let new: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| {
            !rep0
                .findings
                .iter()
                .any(|g| g.code == f.code && g.entity == f.entity && g.detail == f.detail)
        })
        .collect();
    assert!(
        new.is_empty(),
        "{:#?}",
        new.iter()
            .map(|f| (f.check, f.code.clone(), f.entity.clone(), f.detail.clone()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn the_drains_still_fail_with_wallet_posts() {
    let (mut seg, mut snap) = segment();
    with_wallet_posts(&mut seg, &mut snap);
    let (c, s, f) = (
        txs_with(&seg, T_CLAIM)[0],
        txs_with(&seg, T_SETTLE)[0],
        txs_with(&seg, T_FINALIZE)[0],
    );
    drain(&mut seg, c, 7, 1_000_000);
    drain(&mut seg, s, 5, 1_000_000);
    drain(&mut seg, f, 2, 1_000_000);
    let found = vwl::judge_segment(&seg, &snap);
    for t in [c, s, f] {
        assert!(at(&found, t, "WideReplayMismatch"), "{:#?}", show(&found));
    }
}

#[test]
fn a_wallet_owned_account_read_as_the_programs_fails() {
    // The Citizen's state before owned by another program: never read as
    // the program's Citizen.
    let (seg, mut snap) = segment();
    let t = txs_with(&seg, T_CLAIM)[0];
    witness(&mut snap, &ix_key(&seg, t, 3)).owner = Address::new_from_array([9; 32]);
    let found = vwl::judge_segment(&seg, &snap);
    assert!(at(&found, t, "WideAccounts"), "{:#?}", show(&found));
}
