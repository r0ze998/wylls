//! VWL on the wide HOST and BELL (Q16-1 = A continued, 2026-11-19): the
//! recording behind WideMuster and WideResolve, and with them the wide
//! **keep capture** — a hostile host mustered on a wide province's keep
//! tile, then one real WideResolve per bell until the keep's 72-bell hold
//! (`keep_bells` of the Season) is complete and the keep changes hands.
//!
//! One recording of the devnet-playable `.so` built from `origin/main`
//! `1c55036b` (sha256 70b41975…, the program #76 recorded; the program is
//! unchanged on this branch) in the in-process LiteSVM chain
//! (`localnet::Chain`), made by `record_playable_wide_march` (ignored;
//! needs the artefact), the UNFILTERED feed (wallet post-states and
//! finals included):
//!
//! 1. the season, the wide land and the rim homes exactly as
//!    `playable_wide_next.rs` makes them (its declared patches 1 and 2:
//!    RingSeed(128) + the Frontier's wedge counters; the players' final
//!    Town homes at the rim (128, 0));
//! 2. witnessed from here (`playable-march-segment.json.gz` +
//!    `playable-march-snapshot.json.gz`): a hostile player's slot-2 wide
//!    claim on the province, its fresh settle, WideFinalize; **every bell**
//!    of the province resolved by a real WideResolve from its opening bell
//!    on, each over THE anchor and SeedCache of the bell (**declared patch
//!    2'**: the same patch as #72's ticket bells, one per resolved bell,
//!    with a literal seed: no live drand, the O-M1-12 gate); **declared
//!    patch 4**: the hostile holding's Spearman reserve; a real WideMuster
//!    of that host onto the keep's tile; then one real WideResolve per bell
//!    until the keep is TAKEN, and a few bells more; two refusals by the
//!    program archived (a resolve out of order, a muster above the
//!    reserve).
//! 3. `playable-march-whole.json.gz`: the whole archive from
//!    AnnounceSeason on (season mode; the patches show as state no
//!    instruction wrote).
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_WIDE_DUMP=/abs/dir \
//!  cargo test -p verify --features playable-lane --test playable_wide_march -- --ignored --nocapture`

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
    arrival as wa, holding as wh,
    land::{self as wl, WideProvince},
    roster as wro,
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    ticket as wt, wide_ix as wix, ProvinceKey, WideCoord, WorldId,
};
use permutation_rules::frontier::beacon::{
    self as kb, genesis_seed_round, genesis_ts as beacon_genesis_ts, ring_seed_round, round_time,
    BeaconClock, WindowSchedule,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord, PLACEMENT_MIXED};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use permutation_rules::frontier::keep::Keep;
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

fn player_metas(a: &Addresses, m: &Member) -> Vec<AccountMeta> {
    let w = m.wallet.pubkey();
    vec![
        AccountMeta::new_readonly(w, true),
        AccountMeta::new(w, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(m.citizen), false),
    ]
}

/// 0xDF WideFinalize of the wide holding at `(coord, site)`.
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

/// 0xDA op 1 WideMuster of `troops` of `unit` from `m`'s wide holding at
/// `(coord, site)` onto `tile` of its own province.
fn muster_ix(
    a: &Addresses,
    m: &Member,
    coord: WideCoord,
    site: u8,
    unit: u8,
    troops: u32,
    tile: u8,
) -> Instruction {
    let c = ctx_of(a);
    let pkey = ProvinceKey::new(world_of(a), coord);
    let mut accounts = player_metas(a, m);
    accounts.push(AccountMeta::new(
        adr(wh::holding_address(&c, coord, site)),
        false,
    ));
    accounts.push(AccountMeta::new(
        adr(wl::province_address(&c, coord)),
        false,
    ));
    accounts.push(AccountMeta::new(adr(wro::roster_address(&c, pkey)), false));
    accounts.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    wide_ix(
        a,
        accounts,
        wix::Muster { unit, troops, tile }.to_bytes().to_vec(),
    )
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

/// The keep of the wide province at `coord` in the chain now.
fn keep_now(r: &Rec, coord: WideCoord) -> Keep {
    let d = r
        .data(&adr(wl::province_address(&ctx_of(&r.a), coord)))
        .expect("the wide province");
    frontier_abi::conquest_model::read_keep(&d)
        .expect("the keep reads")
        .expect("a keep")
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
#[ignore = "needs the devnet-playable .so built from main: set PSF_PLAYABLE_SO (sha256 70b41975…), run with --ignored"]
fn record_playable_wide_march() {
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

    // ---- 4. The witnessed segment: a hostile claim, every bell resolved,
    // the muster onto the keep, the 72-bell hold, the capture.
    let seg_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    r.snapshot = Some(BTreeMap::new());
    r.written.clear();
    let p0 = opened[0];
    let reg0 = WideProvince::read(&r.data(&adr(wl::province_address(&ctx, p0))).unwrap())
        .unwrap()
        .region;
    let bell_now = |r: &Rec| -> u32 {
        frontier_abi::prologue::bell_at(genesis_ts, r.c.unix_timestamp()).unwrap()
    };
    let keep0 = keep_now(&r, p0);
    assert!(!keep0.heartland_safe, "a contestable keep");
    assert_eq!(keep0.required, 72, "the Season's keep_bells");
    let hi = members
        .iter()
        .position(|m| m.faction != keep0.holder)
        .expect("a player hostile to the keep's holder");
    r.log.push(format!(
        "the keep of {p0:?}: tile {}, holder faction {}, {} troops; the hostile player is player {hi} (faction {})",
        keep0.tile, keep0.holder, keep0.troops, members[hi].faction
    ));
    let pd0 = r.data(&adr(wl::province_address(&ctx, p0))).unwrap();
    let site = (0..pd0[PV::SITE_COUNT])
        .find(|&s| {
            let o = PV::site(s as usize);
            let ro = frontier_abi::v2::layout::province::province::record(s as usize);
            pd0[o + SM::STATE] == SM::STATE_FREE && pd0[ro..ro + 32].iter().all(|b| *b == 0)
        })
        .expect("a free site");
    let b0 = bell_now(&r);
    r.send(
        &[&members[hi].wallet],
        &[claim_ix(&a, &members[hi], p0, site, 2, None)],
        &format!("WideClaimSite player {hi} ({p0:?}, site {site}) slot 2"),
    );
    let final0 = stage_seed(&mut r, b0, reg0, seed_of(b0));
    r.send(
        &[&payer],
        &[settle_ix(
            &a,
            &payer.pubkey(),
            &members[hi],
            p0,
            site,
            b0,
            reg0,
            None,
        )],
        &format!("WideSettleTicket player {hi} (fresh)"),
    );
    r.advance_to(final0.max(r.c.unix_timestamp()) + 5);
    r.send(
        &[&payer],
        &[finalize_ix(&a, &payer.pubkey(), p0, site)],
        "WideFinalize",
    );
    let now_b = bell_now(&r);
    resolve_through(&mut r, &payer, p0, reg0, now_b);
    let snap_a = r.snapshot.take().unwrap();
    let (a_txs, a_finals) = r.archive(seg_from, &program);
    // Patch 4: the hostile holding's Spearman reserve (between the two
    // witnessed segments, so the second one's witness shows it).
    let hk = wh::holding_address(&ctx, p0, site);
    const TROOPS: u32 = 3_000;
    r.edit(
        hk,
        &format!("player {hi}'s wide holding: {TROOPS} Spearmen in reserve"),
        |d| {
            let ro = H::reserve(0);
            d[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
        },
    );
    let seg_b_from = r.c.feed(0, usize::MAX, Some(&program)).len();
    r.snapshot = Some(BTreeMap::new());
    r.written.clear();
    let m = &members[hi];
    r.try_send(
        &[&m.wallet],
        &[muster_ix(&a, m, p0, site, 0, TROOPS + 1, keep0.tile)],
        "WideMuster above the reserve (refused)",
    );
    r.send(
        &[&m.wallet],
        &[muster_ix(&a, m, p0, site, 0, TROOPS, keep0.tile)],
        &format!(
            "WideMuster player {hi}: {TROOPS} Spearmen onto the keep's tile {}",
            keep0.tile
        ),
    );
    let bm = bell_now(&r);
    let rn = resolved_next(&r, p0);
    stage_seed(&mut r, rn + 1, reg0, seed_of(rn + 1));
    r.try_send(
        &[&payer],
        &[resolve_ix(&a, &payer.pubkey(), p0, rn + 1, reg0)],
        &format!("WideResolve bell {} out of order (refused)", rn + 1),
    );
    // The hold: one resolve per bell until the keep is taken, then 3 more.
    let mut taken_at = None;
    for _ in 0..400 {
        let b = resolved_next(&r, p0);
        resolve_through(&mut r, &payer, p0, reg0, b + 1);
        let k = keep_now(&r, p0);
        if taken_at.is_none() && k.changes > keep0.changes {
            taken_at = Some(b);
            r.log.push(format!(
                "the keep TAKEN at bell {b}: holder {} → {}, garrison {} troops (muster bell {bm})",
                keep0.holder, k.holder, k.troops
            ));
        }
        if taken_at.is_some_and(|t| b >= t + 3) {
            break;
        }
    }
    let taken_at = taken_at.expect("the keep is taken within 400 bells");
    let snapshot = r.snapshot.take().unwrap();
    let (seg_txs, seg_finals) = r.archive(seg_b_from, &program);
    let prov = format!(
        "verify/tests/playable_wide_march.rs record_playable_wide_march: the devnet-playable .so built from origin/main 1c55036b (sha256 {MAIN_SHA256}) in localnet::Chain (LiteSVM, in process); a real placement-2 season by its own instructions, the declared wide land patch (RingSeed(128), Frontier wedge counters) and the real ring-129 opening, the declared rim-homes patch (three players' PlaceHome holdings copied to the rim (128,0) as final Towns with stores, a v2 Province there, the Citizens' slot 1 re-pointed); witnessed: a hostile player's slot-2 claim, settle and WideFinalize, a real WideResolve of every bell from the province's opening, THE anchor and SeedCache of each resolved or ticket bell patched with a literal seed (no live drand), the declared reserve patch ({TROOPS} Spearmen), a real WideMuster onto the keep's tile, the keep taken at bell {taken_at} after its 72-bell hold; the UNFILTERED feed (wallet post-states, witness states and finals included); steps: {}",
        r.log.join("; ")
    );
    let seg_a = input_of(
        program,
        so_hash,
        a_txs,
        a_finals,
        r.c.slot(),
        format!("the first witnessed segment (the claim, settle, finalize and every resolve to bell {now_b}); {prov}"),
        "playable-march-a-segment",
    );
    let snap_a = input_of(
        program,
        so_hash,
        vec![],
        snap_a,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the first segment names, read before its first use; {prov}"),
        "playable-march-a-snapshot",
    );
    let found_a = vwl::judge_segment(&seg_a, &snap_a.finals);
    for f in &found_a {
        println!(
            "segment a {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    let segment = input_of(
        program,
        so_hash,
        seg_txs,
        seg_finals,
        r.c.slot(),
        format!("the second witnessed segment (the muster, the hold, the capture); {prov}"),
        "playable-march-b-segment",
    );
    let snap = input_of(
        program,
        so_hash,
        vec![],
        snapshot,
        r.c.slot(),
        format!("the pre-states (finals field) of every account the second segment names (after the reserve patch), read before its first use; {prov}"),
        "playable-march-b-snapshot",
    );
    let found = vwl::judge_segment(&segment, &snap.finals);
    for f in &found {
        println!(
            "segment b {:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    for l in &r.log {
        println!("{l}");
    }
    let (all_txs, all_finals) = r.archive(0, &program);
    let whole = input_of(
        program,
        so_hash,
        all_txs,
        all_finals,
        r.c.slot(),
        format!("the whole archive from AnnounceSeason on, the declared patches showing as state the archive never saw an instruction write; {prov}"),
        "playable-march-whole",
    );
    if let Ok(dir) = std::env::var("PLAYABLE_WIDE_DUMP") {
        let d = std::path::Path::new(&dir);
        whole
            .save(&d.join("playable-march-whole.json.gz"))
            .expect("save");
        seg_a
            .save(&d.join("playable-march-a-segment.json.gz"))
            .expect("save");
        snap_a
            .save(&d.join("playable-march-a-snapshot.json.gz"))
            .expect("save");
        segment
            .save(&d.join("playable-march-b-segment.json.gz"))
            .expect("save");
        snap.save(&d.join("playable-march-b-snapshot.json.gz"))
            .expect("save");
        println!("saved to {dir}");
    }
    assert_eq!(
        rep.verdict,
        verify_core::Verdict::Pass,
        "the natural season"
    );
    assert!(found_a.is_empty(), "the honest first segment");
    assert!(found.is_empty(), "the honest second segment");
}

// ------------------------------------------------------------ the fixtures

type Snap = BTreeMap<[u8; 32], Option<Account>>;

fn seg_a() -> (Input, Snap) {
    (
        common::fixture("playable-march-a-segment.json.gz"),
        common::fixture("playable-march-a-snapshot.json.gz").finals,
    )
}

fn seg_b() -> (Input, Snap) {
    (
        common::fixture("playable-march-b-segment.json.gz"),
        common::fixture("playable-march-b-snapshot.json.gz").finals,
    )
}

fn whole() -> Input {
    common::fixture("playable-march-whole.json.gz")
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

fn post_data(inp: &Input, t: usize, k: &[u8; 32]) -> Vec<u8> {
    inp.txs[t]
        .post
        .iter()
        .find(|(x, _)| x.to_bytes() == *k)
        .and_then(|(_, a)| a.clone())
        .expect("a post-state")
        .data
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

fn at(found: &[verify_core::Finding], t: usize) -> Vec<&verify_core::Finding> {
    found
        .iter()
        .filter(|f| f.check == "VWL" && f.entity == format!("tx#{t}"))
        .collect()
}

fn fails_at(found: &[verify_core::Finding], t: usize, code: &str, needle: &str) -> bool {
    at(found, t).iter().any(|f| {
        f.severity == verify_core::Severity::Fail && f.code == code && f.detail.contains(needle)
    })
}

/// Only `MissingData` at `t` (and at least one).
fn only_missing_at(found: &[verify_core::Finding], t: usize) -> bool {
    let a = at(found, t);
    !a.is_empty()
        && a.iter()
            .all(|f| f.severity == verify_core::Severity::Unverifiable && f.code == "MissingData")
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

fn muster_head() -> Vec<u8> {
    wix::Muster {
        unit: 0,
        troops: 0,
        tile: 0,
    }
    .to_bytes()[..3]
        .to_vec()
}

fn resolve_head() -> Vec<u8> {
    wix::Resolve {
        bell: 0,
        beneficiary: [0; 32],
    }
    .to_bytes()[..3]
        .to_vec()
}

fn keep_of(d: &[u8]) -> Keep {
    frontier_abi::conquest_model::read_keep(d)
        .expect("the keep reads")
        .expect("a keep")
}

fn set_keep(d: &mut [u8], k: &Keep) {
    frontier_abi::conquest_model::write_keep(d, k).expect("the keep writes");
}

/// Segment B's resolves, and the one whose post-state shows the keep
/// taken.
fn capture(inp: &Input, snap: &Snap) -> (Vec<usize>, usize) {
    let rs = txs_like(inp, &resolve_head(), true);
    let t = *rs
        .iter()
        .find(|&&t| {
            let pk = ix_key(inp, t, 2);
            keep_of(&state_before(inp, snap, t, &pk).data).changes
                < keep_of(&post_data(inp, t, &pk)).changes
        })
        .expect("a capture");
    (rs, t)
}

// ------------------------------------------------------------ honest

#[test]
fn the_honest_claim_resolves_muster_hold_and_capture_re_run() {
    let (a, sa) = seg_a();
    let fa = vwl::judge_segment(&a, &sa);
    assert!(fa.is_empty(), "{:#?}", show(&fa));
    assert!(txs_like(&a, &resolve_head(), true).len() >= 2);
    let (b, sb) = seg_b();
    let fb = vwl::judge_segment(&b, &sb);
    assert!(fb.is_empty(), "{:#?}", show(&fb));
    // What the recording holds: one muster onto the keep's tile, the hold
    // and the capture, each resolve re-run.
    assert_eq!(txs_like(&b, &muster_head(), true).len(), 1);
    let (rs, t) = capture(&b, &sb);
    assert!(rs.len() >= 75, "{} resolves", rs.len());
    let pk = ix_key(&b, t, 2);
    let (k0, k1) = (
        keep_of(&state_before(&b, &sb, t, &pk).data),
        keep_of(&post_data(&b, t, &pk)),
    );
    assert_ne!(k0.holder, k1.holder, "the keep changed hands");
    assert_eq!(k0.required, 72);
    assert_eq!(k0.progress, 71, "the 72nd held bell takes it");
    // The program's own refusals are archived and not judged.
    assert_eq!(txs_like(&b, &muster_head(), false).len(), 1);
    assert_eq!(txs_like(&b, &resolve_head(), false).len(), 1);
    // The unfiltered feed: wallet post-states are in the archive.
    let wallet = |x: &Option<Account>| x.as_ref().is_some_and(|x| x.owner != b.cfg.program);
    assert!(b.txs.iter().any(|t| t.post.iter().any(|(_, x)| wallet(x))));
}

// ------------------------------------------------------------ the keep

#[test]
fn a_keep_handed_back_to_its_holder_at_the_capture_fails() {
    let (mut b, sb) = seg_b();
    let (_, t) = capture(&b, &sb);
    let pk = ix_key(&b, t, 2);
    let k0 = keep_of(&state_before(&b, &sb, t, &pk).data);
    edit_post(&mut b, t, &pk, |a| {
        let mut k = keep_of(&a.data);
        k.holder = k0.holder;
        set_keep(&mut a.data, &k);
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "the wide province"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_capture_before_the_72_bell_hold_fails() {
    let (mut b, sb) = seg_b();
    let (rs, t) = capture(&b, &sb);
    let pk = ix_key(&b, t, 2);
    let taken = keep_of(&post_data(&b, t, &pk));
    // Ten bells into the hold, the post-state claims the capture.
    let early = rs
        .iter()
        .copied()
        .find(|&u| keep_of(&post_data(&b, u, &pk)).progress == 10)
        .expect("a bell ten into the hold");
    edit_post(&mut b, early, &pk, |a| {
        let mut k = keep_of(&a.data);
        k.holder = taken.holder;
        k.changes = taken.changes;
        k.progress = 0;
        k.contender = taken.contender;
        k.gen = taken.gen;
        set_keep(&mut a.data, &k);
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, early, "WideReplayMismatch", "the wide province"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_hold_counted_twice_in_one_bell_fails() {
    let (mut b, sb) = seg_b();
    let (rs, t) = capture(&b, &sb);
    let pk = ix_key(&b, t, 2);
    let mid = rs
        .iter()
        .copied()
        .find(|&u| keep_of(&post_data(&b, u, &pk)).progress == 30)
        .expect("a bell thirty into the hold");
    edit_post(&mut b, mid, &pk, |a| {
        let mut k = keep_of(&a.data);
        k.progress += 1;
        set_keep(&mut a.data, &k);
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, mid, "WideReplayMismatch", "the wide province"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_resolve_under_another_seed_fails() {
    let (b, mut sb) = seg_b();
    let (rs, _) = capture(&b, &sb);
    let t = rs[0];
    let seed_k = ix_key(&b, t, 4);
    let cache = sb
        .get_mut(&seed_k)
        .and_then(|a| a.as_mut())
        .expect("the SeedCache in the witness");
    cache.data[SC::SEED] ^= 1;
    let f = vwl::judge_segment(&b, &sb);
    assert!(fails_at(&f, t, "WideReplayMismatch", ""), "{:#?}", show(&f));
}

#[test]
fn a_resolve_before_its_reveal_window_closed_fails() {
    let (mut b, sb) = seg_b();
    let (rs, _) = capture(&b, &sb);
    let t = rs[3];
    // The bell's own start: before THE anchor's window can have closed.
    let sd = state_before(&b, &sb, t, &ix_key(&b, t, 1)).data;
    let genesis = i64::from_le_bytes(sd[S::GENESIS_TS..][..8].try_into().unwrap());
    let bell = wix::Resolve::decode(&first_ix(&b, t).unwrap().0)
        .unwrap()
        .bell;
    b.txs[t].block_time = genesis + 600 * bell as i64 + 1;
    let f = vwl::judge_segment(&b, &sb);
    assert!(fails_at(&f, t, "WideRule", "TooEarly"), "{:#?}", show(&f));
}

#[test]
fn a_resolve_of_a_bell_that_is_not_due_fails() {
    let (mut b, mut sb) = seg_b();
    let (rs, _) = capture(&b, &sb);
    let t = rs[5];
    let pk = ix_key(&b, t, 2);
    edit_before(&mut b, &mut sb, t, &pk, |a| {
        let o = PV::RESOLVED_NEXT;
        let v = u32::from_le_bytes(a.data[o..o + 4].try_into().unwrap()) - 1;
        a.data[o..o + 4].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(fails_at(&f, t, "WideRule", "OutOfOrder"), "{:#?}", show(&f));
}

#[test]
fn a_resolve_whose_record_is_printed_twice_fails_and_a_lost_record_is_unverifiable() {
    let (b0, sb) = seg_b();
    let (rs, _) = capture(&b0, &sb);
    let t = rs[2];
    let data = |b: &Input| -> usize {
        b.txs[t]
            .logs
            .iter()
            .position(|l| l.starts_with("Program data:"))
            .expect("the printed record")
    };
    let mut b = b0.clone();
    let i = data(&b);
    let line = b.txs[t].logs[i].clone();
    b.txs[t].logs.insert(i, line);
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "2 wide records"),
        "{:#?}",
        show(&f)
    );
    let mut b = b0;
    let i = data(&b);
    b.txs[t].logs.remove(i);
    let f = vwl::judge_segment(&b, &sb);
    assert!(only_missing_at(&f, t), "{:#?}", show(&f));
}

#[test]
fn a_resolve_that_drains_the_province_fails_and_a_gift_is_unverifiable() {
    let (b0, sb) = seg_b();
    let (rs, _) = capture(&b0, &sb);
    let t = rs[4];
    let pk = ix_key(&b0, t, 2);
    let mut b = b0.clone();
    edit_post(&mut b, t, &pk, |a| a.lamports -= 1);
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "lost 1 lamports"),
        "{:#?}",
        show(&f)
    );
    let mut b = b0;
    edit_post(&mut b, t, &pk, |a| a.lamports += 1);
    let f = vwl::judge_segment(&b, &sb);
    assert!(only_missing_at(&f, t), "{:#?}", show(&f));
}

#[test]
fn a_resolve_whose_anchor_the_witness_lacks_is_unverifiable() {
    let (b, mut sb) = seg_b();
    let (rs, _) = capture(&b, &sb);
    let t = rs[6];
    sb.remove(&ix_key(&b, t, 5));
    let f = vwl::judge_segment(&b, &sb);
    assert!(only_missing_at(&f, t), "{:#?}", show(&f));
}

#[test]
fn a_resolve_that_writes_an_unlisted_program_account_fails() {
    let (mut b, sb) = seg_b();
    let (rs, _) = capture(&b, &sb);
    let t = rs[7];
    // The Season (listed read-only) rewritten.
    let sk = ix_key(&b, t, 1);
    let mut sa = state_before(&b, &sb, t, &sk);
    sa.data[S::GENESIS_TS] ^= 1;
    b.txs[t].post.push((Address::new_from_array(sk), Some(sa)));
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "never writes"),
        "{:#?}",
        show(&f)
    );
}

// ------------------------------------------------------------ the muster

fn the_muster(b: &Input) -> usize {
    txs_like(b, &muster_head(), true)[0]
}

#[test]
fn a_muster_that_does_not_debit_the_reserve_fails() {
    let (mut b, sb) = seg_b();
    let t = the_muster(&b);
    let hk = ix_key(&b, t, 4);
    let before = state_before(&b, &sb, t, &hk).data;
    edit_post(&mut b, t, &hk, |a| {
        let o = H::reserve(0);
        a.data[o..o + 4].copy_from_slice(&before[o..o + 4]);
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "the holding"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_muster_of_more_troops_than_the_entry_shows_fails() {
    let (mut b, sb) = seg_b();
    let t = the_muster(&b);
    let pk = ix_key(&b, t, 5);
    use frontier_abi::layout::province::entry as E;
    let pre = state_before(&b, &sb, t, &pk).data;
    let post = post_data(&b, t, &pk);
    let i = (0..PV::ENTRIES_N)
        .find(|&i| pre[PV::entry(i) + E::STATE] != post[PV::entry(i) + E::STATE])
        .expect("the mustered entry");
    edit_post(&mut b, t, &pk, |a| {
        let o = PV::entry(i) + E::TROOPS;
        let v = u32::from_le_bytes(a.data[o..o + 4].try_into().unwrap()) + 1_000;
        a.data[o..o + 4].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "the wide province"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_muster_from_a_provisional_holding_fails() {
    let (mut b, mut sb) = seg_b();
    let t = the_muster(&b);
    let hk = ix_key(&b, t, 4);
    edit_before(&mut b, &mut sb, t, &hk, |a| {
        a.data[H::STATE] = H::STATE_PROVISIONAL
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(fails_at(&f, t, "WideRule", "NotFinal"), "{:#?}", show(&f));
}

#[test]
fn a_muster_into_an_unresolved_province_fails() {
    let (mut b, mut sb) = seg_b();
    let t = the_muster(&b);
    let pk = ix_key(&b, t, 5);
    edit_before(&mut b, &mut sb, t, &pk, |a| {
        let o = PV::RESOLVED_NEXT;
        let v = u32::from_le_bytes(a.data[o..o + 4].try_into().unwrap()) - 3;
        a.data[o..o + 4].copy_from_slice(&v.to_le_bytes());
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideRule", "NotResident"),
        "{:#?}",
        show(&f)
    );
}

#[test]
fn a_muster_from_another_citizens_holding_fails() {
    let (mut b, mut sb) = seg_b();
    let t = the_muster(&b);
    let hk = ix_key(&b, t, 4);
    edit_before(&mut b, &mut sb, t, &hk, |a| {
        let o = H::OWNER_CITIZEN;
        a.data[o] ^= 1;
    });
    let f = vwl::judge_segment(&b, &sb);
    assert!(fails_at(&f, t, "WideRule", "NotOwner"), "{:#?}", show(&f));
}

#[test]
fn a_muster_whose_roster_names_another_host_fails() {
    let (mut b, sb) = seg_b();
    let t = the_muster(&b);
    let rk = ix_key(&b, t, 6);
    let n = post_data(&b, t, &rk).len();
    edit_post(&mut b, t, &rk, |a| a.data[n - 1] ^= 1);
    let f = vwl::judge_segment(&b, &sb);
    assert!(
        fails_at(&f, t, "WideReplayMismatch", "roster"),
        "{:#?}",
        show(&f)
    );
}

// ------------------------------------------------------------ season mode

/// The FAILs of the whole archive, by check, entity and transaction.
fn season_fails(inp: &Input) -> Vec<(String, String, String)> {
    verify_core::verify(inp)
        .findings
        .iter()
        .filter(|f| f.severity == verify_core::Severity::Fail)
        .map(|f| (f.check.to_string(), f.code.clone(), f.entity.clone()))
        .collect()
}

#[test]
fn season_mode_judges_the_muster_and_every_resolve_with_no_false_fail() {
    let w = whole();
    let rep = verify_core::verify(&w);
    let musters = txs_like(&w, &muster_head(), true);
    let resolves = txs_like(&w, &resolve_head(), true);
    assert_eq!(musters.len(), 1);
    assert!(resolves.len() >= 77);
    // VWL judges both commands: nothing is WideUnmodelled, the roster is a
    // known record (VR), the province's wide chain walks (VW1).
    for f in &rep.findings {
        assert_ne!(f.code, "WideUnmodelled", "{f:?}");
        assert_ne!(f.check, "VR", "{f:?}");
        assert_ne!(f.check, "VW1", "{f:?}");
    }
    // Every resolve is either clean or UNVERIFIABLE for its patched anchor
    // (THE anchor no archived instruction wrote).
    for &t in &resolves {
        for f in at(&rep.findings, t) {
            assert!(
                f.severity == verify_core::Severity::Unverifiable
                    && f.detail.contains("bell anchor"),
                "{f:?}"
            );
        }
    }
    // The only FAILs are the declared patches', which no archive can show
    // (the rim homes and the Frontier: CQ1, the claim; the reserve: the
    // muster), and the same transactions judge clean from the witnesses.
    let claim = txs_like(&w, &[wix::TAG_CLAIM_SITE], true);
    for (check, code, entity) in season_fails(&w) {
        let ok = check == "CQ1"
            || (check == "VWL"
                && (entity == format!("tx#{}", musters[0])
                    || claim.iter().any(|t| entity == format!("tx#{t}"))));
        assert!(ok, "an unexplained FAIL: {check} {code} {entity}");
    }
    let (a, sa) = seg_a();
    let (b, sb) = seg_b();
    assert!(vwl::judge_segment(&a, &sa).is_empty());
    assert!(vwl::judge_segment(&b, &sb).is_empty());
}

/// In this recording THE anchors are declared patches no archived
/// instruction wrote (no live drand offline), so season mode reads every
/// resolve as UNVERIFIABLE before its replay: a capture forged in the
/// post-state AND the final is then never a PASS (the resolve stays
/// `MissingData`), and a forged post-state alone is a FAIL (CQ1). From a
/// witness that shows the anchor, the same forgery is a VWL FAIL
/// (`a_keep_handed_back_to_its_holder_at_the_capture_fails`).
#[test]
fn season_mode_never_passes_a_forged_capture() {
    let w0 = whole();
    let resolves = txs_like(&w0, &resolve_head(), true);
    let t = *resolves.last().unwrap();
    let pk = ix_key(&w0, t, 2);
    let forge = |a: &mut Account| {
        let mut k = keep_of(&a.data);
        k.holder = (k.holder + 1) % 6;
        set_keep(&mut a.data, &k);
    };
    // The post-state alone: the final no longer matches it.
    let mut w = w0.clone();
    edit_post(&mut w, t, &pk, forge);
    assert!(season_fails(&w).iter().any(|(c, code, e)| c == "CQ1"
        && code == "FinalStateMismatch"
        && *e == Address::new_from_array(pk).to_string()));
    // The post-state and the final, consistently.
    let mut w = w0;
    edit_post(&mut w, t, &pk, forge);
    let fin = w
        .finals
        .get_mut(&pk)
        .and_then(|a| a.as_mut())
        .expect("the final");
    forge(fin);
    let rep = verify_core::verify(&w);
    assert_ne!(rep.verdict, verify_core::Verdict::Pass);
    assert!(
        only_missing_at(&rep.findings, t),
        "{:#?}",
        show(&rep.findings)
    );
}
