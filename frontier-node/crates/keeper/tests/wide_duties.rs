//! The wide proof extractor and the unsigned duty planners over **literal**
//! bytes: literal addresses, literal 64-byte signature bytes, transactions
//! built with `fclient::tx::message` + `Transaction::new_unsigned` (no key,
//! no signing), account fixtures written with the ABI's own encoders, and
//! a fake `ChainPort` that counts (and refuses) any `simulate` or `send`.
//! Nothing here starts a chain, verifies a signature or sends anything.
//! Run with
//! `cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_duties`.
#![cfg(feature = "wide-world-experimental")]

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use base64::Engine as _;
use fclient::beacon::{QUICKNET_GENESIS, QUICKNET_PERIOD};
use fclient::budgets::Budgets;
use fclient::clock::SeasonClock;
use fclient::decode::{is_absent, Season};
use fclient::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};
use fclient::rpc::account_json;
use fclient::tx::{self, TxBudget};
use fclient::{Hash, Transaction};
use findex::wide_index::WideIndex;
use findex::wide_store::WideFindex;
use findex::Source;
use frontier_abi::addr::{archive_part_of, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use frontier_abi::clash_model::{Camp, DAY_BELLS, RESOURCES, TERRAINS};
use frontier_abi::conquest_model::write_keep;
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::beacon::{
    anchor_archive as AA, archive_entry as AE, bell_anchor as BA, seed_cache as SC,
};
use frontier_abi::layout::header;
use frontier_abi::layout::province::camp as CP;
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::world::season as SL;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::layout::province::{province as PV2, site as SM};
use frontier_abi::v2::presets::{CONQUEST_PARAMS_LEN, MC_LOCAL_7D, SEASON_CQ_OFFSET};
use frontier_abi::world_index::event::WideTarget;
use frontier_abi::world_index::event::{self as wev, encode, WideEntity, WideKind, WideLink};
use frontier_abi::world_index::wide_ix::{
    self as wix, Depart, Gather, ResidentAct, Resolve, Return, SettleDeparture,
};
use frontier_abi::world_index::{
    arrival as wa, holding as wh, land as wl, march as wm, roster as wro, seal as wseal,
    MarchEvent, MarchState, ProvinceKey, TileAddress, WideCoord, WideHolding, WideHostRef,
    WideProvince, WideRoster, WideTransit, WorldId, HOST_IDENTITY_FULL_REF_V1, WIDE_SEAL_LEN,
};
use keeper_core::engine::{Engine, EngineParams};
use keeper_core::wideduty::{self, Block, Candidate, Deployment, Duty, Reads, Step, RETURN_MAX};
use keeper_core::widefees::{self, Funding, Known};
use keeper_core::widefollow::{
    preflight, WideFollow, MAX_PAGE_BYTES, MAX_PAGE_RECORDS, MAX_RECORD_BYTES,
    MAX_RECORD_ERR_BYTES, MAX_RECORD_LOG_BYTES, MAX_RECORD_LOG_LINES, MAX_RECORD_LOG_LINE_BYTES,
    MAX_RECORD_POST_ACCOUNTS, MAX_RECORD_POST_DATA_BYTES, MAX_RECORD_WIRE_BYTES,
    PAGES_PER_TICK as FOLLOW_PAGES_PER_TICK, STOP_OBSERVER_BLOCKED, STOP_OVERSIZED,
    STOP_PAGE_BYTES, STOP_PAGE_ORDER, STOP_RECORD_BYTES, STOP_RECORD_ERR, STOP_RECORD_LOGS,
    STOP_RECORD_POST, STOP_RECORD_WIRE,
};
use keeper_core::wideindex::{Limits, Scope as IndexScope, WideBatch, WideDiscovery, WideObserver};
use keeper_core::wideproof::{depart_proof, ProofScope, Unavailable};
use keeper_core::wideproof::{METHOD_FEED, METHOD_SUPPLIED};
use keeper_core::widereconcile::{reconcile, Verdict};
use keeper_core::widereveal::{proofs_for, Publication};
use keeper_core::widereview::{self, Deny, EngineView};
use keeper_core::widesnapshot::{parse_snapshot_response, sysvar_owner, RentSysvar, Snapshot};
use keeper_core::widesnapshot::{snapshot_via, PortSnapshot, SnapshotError, SnapshotPort};
use keeper_core::widetick::{
    block_code, ProofStore, PublicationSource, RevealInputs, WideReview, CANDIDATES_PER_TICK,
    MAX_EXTRACT_PER_PAGE, MAX_PROOFS, MAX_TRANSIENT_RETRIES, ORIGIN_FEED, ORIGIN_SUPPLIED,
    PAYER_UNSET, REFRESH_SLOTS, REVEAL_REFRESH_SLOTS,
};
use permutation_rules::frontier::beacon::bell_end;
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::geometry::{ProvinceCoord, PROVINCE_TILES};
use permutation_rules::frontier::keep::{Keep, NO_FACTION};
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};
use serde_json::Value as JsonValue;
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use std::sync::atomic::AtomicBool;

// ------------------------------------------------------------ identities

const SEASON_ID: u64 = 9;
const SITE: u8 = 3;
const GEN: u8 = 1;
const SLOT: u8 = 1;
const DEPART_BELL: u32 = 6;
const ARRIVE_BELL: u32 = 20;
const TIP: u64 = 5_000;
const TROOPS: u32 = 300_000;
const SIG_PAYER: [u8; 64] = [0x51; 64];
const SIG_ACTOR: [u8; 64] = [0x52; 64];
const COMMIT: [u8; 32] = [0x11; 32];
const WIDE_VERSION: u16 =
    frontier_abi::v2::presets::PROGRAM_VERSION_S1 | wix::WIDE_EXPERIMENTAL_VERSION_BIT;
/// The ruleset hash the test Season carries and the planner is pinned to
/// (a literal: no deployment choice is made here).
const RULESET: [u8; 32] = [0x77; 32];
const GENESIS_TS: i64 = 1_790_444_847;

fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn season_pda() -> (Address, u8) {
    fclient::addr::season_pda(&program(), SEASON_ID)
}
fn scope() -> ProofScope {
    ProofScope {
        program: program(),
        season: season_pda().0,
    }
}
/// The planners' scope with the deployment pinned to the fixture's values.
fn dscope() -> wideduty::Scope {
    wideduty::Scope {
        program: program(),
        season: season_pda().0,
        deployment: Some(Deployment {
            program_version: WIDE_VERSION,
            ruleset_hash: RULESET,
        }),
    }
}
fn ctx() -> AddrCtx {
    AddrCtx {
        season: season_pda().0.to_bytes(),
        program: program().to_bytes(),
    }
}
fn world() -> WorldId {
    WorldId::derive_legacy_season(&season_pda().0.to_bytes(), &program().to_bytes()).unwrap()
}
fn other_world() -> WorldId {
    WorldId::new([0x78; 32]).unwrap()
}
fn key(w: WorldId, p: i64, q: i64) -> ProvinceKey {
    ProvinceKey::new(w, WideCoord::checked(p, q).unwrap())
}
fn home() -> ProvinceKey {
    key(world(), 129, 0)
}
fn away() -> ProvinceKey {
    key(world(), 129, -1)
}
fn host() -> WideHostRef {
    WideHostRef::new(home(), SITE, GEN, 7).unwrap()
}
fn host_b() -> WideHostRef {
    WideHostRef::new(home(), SITE, GEN, 8).unwrap()
}
fn payer() -> Address {
    Address::new_from_array([0xA1; 32])
}
fn actor() -> Address {
    Address::new_from_array([0xA2; 32])
}
fn citizen() -> [u8; 32] {
    [0xC1; 32]
}
fn seal() -> [u8; WIDE_SEAL_LEN] {
    let mut s = [0x33u8; WIDE_SEAL_LEN];
    s[0] = 0x80;
    s
}
fn root() -> [u8; 32] {
    wseal::seal_root(&COMMIT, &wseal::ct_hash(&seal()))
}

fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}
fn holding_addr(coord: WideCoord, site: u8) -> Address {
    addr(wh::holding_address(&ctx(), coord, site))
}
fn transit_addr(holding: Address, slot: u8) -> Address {
    addr(wm::transit_address(&ctx(), &holding.to_bytes(), slot))
}
fn province_addr(k: ProvinceKey) -> Address {
    addr(wl::province_address(&ctx(), k.coord()))
}
fn roster_addr(k: ProvinceKey) -> Address {
    addr(wro::roster_address(&ctx(), k))
}

// ------------------------------------------------------------ account fixtures

fn acct(data: Vec<u8>) -> Option<Account> {
    Some(Account {
        lamports: 1_000_000,
        data,
        owner: program(),
        executable: false,
    })
}

fn season_with(status: u8, version: u16, hash: [u8; 32]) -> Vec<u8> {
    let mut d = vec![0u8; SL::SIZE];
    assert!(wr_arr(&mut d, SL::HDR_MAGIC, &SL::MAGIC));
    assert!(wr_u64(&mut d, SL::SEASON_ID, SEASON_ID));
    assert!(wr_u16(&mut d, SL::LAYOUT_VERSION, 2));
    assert!(wr_u8(&mut d, SL::STATUS, status));
    assert!(wr_u8(&mut d, SL::BUMP, season_pda().1));
    assert!(wr_arr(&mut d, SL::RULESET_HASH, &hash));
    assert!(wr_u16(&mut d, SL::PROGRAM_VERSION, version));
    assert!(wr_u32(&mut d, SL::BELL_SECS, 600));
    assert!(wr_arr(&mut d, SL::GENESIS_TS, &GENESIS_TS.to_le_bytes()));
    assert!(wr_u32(&mut d, SL::END_BELL, 10_000));
    d
}
fn season_bytes(status: u8, version: u16) -> Vec<u8> {
    season_with(status, version, RULESET)
}
fn season_ok() -> Vec<u8> {
    season_bytes(SL::STATUS_RUNNING, WIDE_VERSION)
}
fn clock_at(ts: i64) -> ClockSysvar {
    ClockSysvar {
        slot: 900,
        unix_timestamp: ts,
        ..ClockSysvar::default()
    }
}

fn province_bytes(k: ProvinceKey, resolved_next: u32) -> Vec<u8> {
    province_bytes_in(k, resolved_next, 0)
}
/// [`province_bytes`] with a stored region.
fn province_bytes_in(k: ProvinceKey, resolved_next: u32, region: u8) -> Vec<u8> {
    let p = WideProvince {
        season_id: SEASON_ID,
        world: k.world(),
        coord: k.coord(),
        wedge: k.coord().wedge().unwrap(),
        region,
        opened_bell: 1,
        readiness: wl::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x5e; 32],
        funded_lamports: 0,
    };
    let mut d = vec![0u8; wl::province::SIZE];
    p.write_identity(&mut d).unwrap();
    assert!(wr_u32(&mut d, PV::RESOLVED_NEXT, resolved_next));
    d
}
/// A legacy Province v2's bytes (its magic, its size): the legacy/wide
/// boundary.
fn legacy_province_bytes() -> Vec<u8> {
    let mut d = vec![0u8; PV2::SIZE];
    assert!(wr_arr(&mut d, 0, b"PSF1PROV"));
    assert!(wr_u64(&mut d, 8, SEASON_ID));
    assert!(wr_u16(&mut d, 16, 2));
    d
}
fn entry(alias: u64, state: u8, op: EntryOp, unit: u8, troops: u32) -> Entry {
    Entry {
        id: alias,
        faction: 0,
        unit,
        tile: 5,
        state,
        troops,
        stamina_value: 61,
        dealt_bps: 0,
        stamina_bell: DEPART_BELL,
        ready_bell: DEPART_BELL,
        from_bell: 1,
        pend_bell: 0,
        op,
    }
}
fn put_entry(pd: &mut [u8], i: usize, e: &Entry) {
    write_entry(pd, i, e).unwrap();
    pd[PV::N_ENTRIES] += 1;
}
/// A roster of `k` with `refs` claimed at their indices; returns the bytes
/// and the aliases the entries must carry.
fn roster_bytes(k: ProvinceKey, refs: &[(usize, WideHostRef)]) -> (Vec<u8>, Vec<u64>) {
    let r = WideRoster::new(SEASON_ID, k, [0xaa; 32]);
    let mut d = vec![0u8; wro::wide_roster::SIZE];
    r.write_header(&mut d).unwrap();
    let aliases = refs
        .iter()
        .map(|(i, h)| r.claim(&mut d, *i, h).unwrap())
        .collect();
    (d, aliases)
}
fn holding_bytes(coord: WideCoord, gen: u8, state: u8, owner: [u8; 32]) -> Vec<u8> {
    let h = WideHolding {
        season_id: SEASON_ID,
        world: world(),
        coord,
        site: SITE,
        gen,
        slot: 2,
        owner_citizen: owner,
        host_identity: HOST_IDENTITY_FULL_REF_V1,
        open_transits: 1,
    };
    let mut d = vec![0u8; wh::wide_holding::SIZE];
    h.write_identity(&mut d).unwrap();
    d[H::STATE] = state;
    d
}
fn transit_bytes(h: WideHostRef, origin: ProvinceKey, settled: bool, root: [u8; 32]) -> Vec<u8> {
    let mut t = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        h,
        2,
        0,
        TileAddress::new(origin, 5).unwrap(),
        DEPART_BELL,
        ARRIVE_BELL,
        0,
        TROOPS,
        61,
        0,
        root,
        TIP,
        0,
        payer().to_bytes(),
    )
    .unwrap();
    if settled {
        t = t
            .step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((TROOPS, 61, 0)),
            )
            .unwrap();
    }
    t.to_bytes().to_vec()
}

fn reads_of(pairs: Vec<(Address, Option<Account>)>) -> Reads {
    let mut r = Reads::new(0);
    r.accounts = pairs.into_iter().collect();
    r
}
fn done<T: std::fmt::Debug>(s: Step<T>) -> Result<T, Block> {
    match s {
        Step::Done(r) => r,
        Step::Need(a) => panic!("unexpected read request: {a:?}"),
    }
}

// ------------------------------------------------------------ settle fixture

/// Every account a SettleDeparture of `host()` from `origin` needs, as it
/// would be when the march is settleable: the origin resolved past the
/// departure bell, the entry departed and paired, the holding final at the
/// host's generation, the transit record departed.
struct SettleFx {
    origin: ProvinceKey,
    season: Vec<u8>,
    holding: Option<Vec<u8>>,
    transit: Option<Vec<u8>>,
    province: Vec<u8>,
    roster: Vec<u8>,
}
impl SettleFx {
    fn new(origin: ProvinceKey) -> SettleFx {
        let (roster, aliases) = roster_bytes(origin, &[(4, host())]);
        let mut province = province_bytes(origin, DEPART_BELL + 1);
        put_entry(
            &mut province,
            4,
            &entry(aliases[0], E::STATE_DEPARTED, EntryOp::None, 2, TROOPS),
        );
        SettleFx {
            origin,
            season: season_ok(),
            holding: Some(holding_bytes(
                home().coord(),
                GEN,
                H::STATE_FINAL,
                citizen(),
            )),
            transit: Some(transit_bytes(host(), origin, false, root())),
            province,
            roster,
        }
    }
    fn holding_addr(&self) -> Address {
        holding_addr(home().coord(), SITE)
    }
    fn transit_addr(&self) -> Address {
        transit_addr(self.holding_addr(), SLOT)
    }
    fn reads(&self) -> Reads {
        reads_of(vec![
            (season_pda().0, acct(self.season.clone())),
            (self.holding_addr(), self.holding.clone().and_then(acct)),
            (self.transit_addr(), self.transit.clone().and_then(acct)),
            (province_addr(self.origin), acct(self.province.clone())),
            (roster_addr(self.origin), acct(self.roster.clone())),
        ])
    }
    fn plan(&self) -> Result<Candidate, Block> {
        self.plan_in(&dscope())
    }
    fn plan_in(&self, scope: &wideduty::Scope) -> Result<Candidate, Block> {
        done(wideduty::plan_settle_departure(
            scope,
            payer(),
            host(),
            SLOT,
            &self.reads(),
        ))
    }
    fn expected_instruction(&self) -> Instruction {
        Instruction {
            program_id: program(),
            accounts: vec![
                AccountMeta::new(payer(), true),
                AccountMeta::new_readonly(season_pda().0, false),
                AccountMeta::new(province_addr(self.origin), false),
                AccountMeta::new(self.holding_addr(), false),
                AccountMeta::new(roster_addr(self.origin), false),
                AccountMeta::new(self.transit_addr(), false),
            ],
            data: SettleDeparture {
                host: host().to_bytes(),
                transit_slot: SLOT,
            }
            .to_bytes()
            .to_vec(),
        }
    }
}

#[test]
fn settle_plan_asks_for_reads_in_two_steps_then_builds_the_exact_six_accounts() {
    let fx = SettleFx::new(home());
    // Step 1: nothing read yet → the Season, the holding, the transit.
    let mut reads = Reads::new(0);
    let s = wideduty::plan_settle_departure(&dscope(), payer(), host(), SLOT, &reads);
    assert_eq!(
        s,
        Step::Need(vec![season_pda().0, fx.holding_addr(), fx.transit_addr()])
    );
    reads
        .accounts
        .insert(season_pda().0, acct(fx.season.clone()));
    reads
        .accounts
        .insert(fx.holding_addr(), fx.holding.clone().and_then(acct));
    reads
        .accounts
        .insert(fx.transit_addr(), fx.transit.clone().and_then(acct));
    // Step 2: the origin the record names, and its roster.
    let s = wideduty::plan_settle_departure(&dscope(), payer(), host(), SLOT, &reads);
    assert_eq!(
        s,
        Step::Need(vec![province_addr(home()), roster_addr(home())])
    );
    reads
        .accounts
        .insert(province_addr(home()), acct(fx.province.clone()));
    reads
        .accounts
        .insert(roster_addr(home()), acct(fx.roster.clone()));
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert_eq!(c.instruction, fx.expected_instruction());
    assert_eq!(c.instruction.accounts.len(), 6);
    assert_eq!(c.instruction.data[0], wix::TAG_SETTLE_TICKET);
    assert_eq!(c.instruction.data[3], wix::OP_SETTLE_DEPARTURE);
    assert!(!c.signed && !c.automatic_send && !c.coherent());
    assert_eq!(c.observed_clock, None);
    let Duty::SettleDeparture(f) = &c.duty else {
        panic!("a settle");
    };
    assert_eq!((f.host, f.transit_slot, f.origin), (host(), SLOT, home()));
    assert_eq!(
        (f.depart_bell, f.resolved_next, f.entry_index),
        (DEPART_BELL, DEPART_BELL + 1, 4)
    );
    assert_eq!(
        (
            f.kernel_troops_milli,
            f.predicted_destroyed,
            f.origin_is_home
        ),
        (TROOPS, false, true)
    );
    assert_eq!(
        (f.troops_after_milli, f.stamina_after),
        (TROOPS, f.kernel_stamina)
    );
    assert_eq!(
        f.ready_bell_off, 0,
        "ready_bell == depart_bell in the fixture"
    );
    assert!(!c.status_promoted_by_clock);
    let d = c.describe();
    assert_eq!(d["kind"], "WideSettleDeparture");
    assert_eq!(d["automatic_send"], false);
    assert_eq!(d["coherent"], false);
    const { assert!(!wideduty::AUTOMATIC_SEND) };
}

#[test]
fn settle_plan_is_permissionless_over_owner_and_generation() {
    // The Citizen was transferred and the site re-founded at generation 2:
    // the settle still plans (the march is the transit record's).
    let mut fx = SettleFx::new(home());
    fx.holding = Some(holding_bytes(
        home().coord(),
        GEN + 1,
        H::STATE_FINAL,
        [0xC2; 32],
    ));
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction, fx.expected_instruction());
    // A released (not live) holding: no capture lock is read, the plan stands.
    fx.holding = Some(holding_bytes(
        home().coord(),
        GEN,
        H::STATE_RELEASED,
        citizen(),
    ));
    assert!(fx.plan().is_ok());
    // From a province that is not the holding's own: no lock, no tenth
    // account (SettleDeparture has exactly six), `origin_is_home` false.
    let fx = SettleFx::new(away());
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction, fx.expected_instruction());
    let Duty::SettleDeparture(f) = &c.duty else {
        panic!("a settle");
    };
    assert!(!f.origin_is_home);
}

#[test]
fn settle_plan_blocks_exactly_where_the_handler_refuses() {
    // No transit record: no march.
    let mut fx = SettleFx::new(home());
    fx.transit = None;
    assert_eq!(fx.plan(), Err(Block::NoMarch));
    // Another host's record at the slot.
    let mut fx = SettleFx::new(home());
    fx.transit = Some(transit_bytes(host_b(), home(), false, root()));
    assert_eq!(fx.plan(), Err(Block::TransitOtherHost));
    // Already settled.
    let mut fx = SettleFx::new(home());
    fx.transit = Some(transit_bytes(host(), home(), true, root()));
    assert_eq!(fx.plan(), Err(Block::AlreadySettled(MarchState::Settled)));
    // The origin not resolved past the departure bell.
    let mut fx = SettleFx::new(home());
    assert!(wr_u32(&mut fx.province, PV::RESOLVED_NEXT, DEPART_BELL));
    assert_eq!(
        fx.plan(),
        Err(Block::TooEarly {
            resolved_next: DEPART_BELL,
            depart_bell: DEPART_BELL
        })
    );
    // The entry back in the roster (state 1): not a departed host.
    let mut fx = SettleFx::new(home());
    let (_, aliases) = roster_bytes(home(), &[(4, host())]);
    write_entry(
        &mut fx.province,
        4,
        &entry(aliases[0], E::STATE_ROSTER, EntryOp::None, 2, TROOPS),
    )
    .unwrap();
    assert_eq!(fx.plan(), Err(Block::EntryState(E::STATE_ROSTER)));
    // The alias in the table without its reference in the roster.
    let mut fx = SettleFx::new(home());
    let (empty, _) = roster_bytes(home(), &[]);
    fx.roster = empty;
    assert_eq!(fx.plan(), Err(Block::RosterUnpaired));
    // No entry at all for the host.
    let mut fx = SettleFx::new(home());
    fx.province = province_bytes(home(), DEPART_BELL + 1);
    fx.roster = roster_bytes(home(), &[]).0;
    assert_eq!(fx.plan(), Err(Block::NotResident));
    // The holding absent at its canonical address.
    let mut fx = SettleFx::new(home());
    fx.holding = None;
    assert_eq!(fx.plan(), Err(Block::Absent("holding")));
    // The holding's own province capture-locks it (mirror at gen + 1).
    let mut fx = SettleFx::new(home());
    let s = PV2::site(SITE as usize);
    fx.province[s + SM::STATE] = SM::STATE_HOLDING;
    fx.province[s + SM::GEN] = GEN + 1;
    assert_eq!(fx.plan(), Err(Block::CapturePending));
    // The same lock does not apply when the origin is not the holding's own.
    let mut fx = SettleFx::new(away());
    let s = PV2::site(SITE as usize);
    fx.province[s + SM::STATE] = SM::STATE_HOLDING;
    fx.province[s + SM::GEN] = GEN + 1;
    assert!(fx.plan().is_ok());
    // Season: a stored status the settles refuse; Seeded depends on the
    // clock; a season without the wide version bit.
    let mut fx = SettleFx::new(home());
    fx.season = season_bytes(SL::STATUS_CREATED, WIDE_VERSION);
    assert_eq!(fx.plan(), Err(Block::SeasonStatus(SL::STATUS_CREATED)));
    fx.season = season_bytes(SL::STATUS_SEEDED, WIDE_VERSION);
    assert_eq!(fx.plan(), Err(Block::SeasonDependsOnClock));
    // A Season of another program version than the pin (here the plain
    // S1 build, without the wide bit).
    fx.season = season_bytes(
        SL::STATUS_ENDED,
        frontier_abi::v2::presets::PROGRAM_VERSION_S1,
    );
    assert_eq!(
        fx.plan(),
        Err(Block::ProgramVersion {
            expected: WIDE_VERSION,
            got: frontier_abi::v2::presets::PROGRAM_VERSION_S1
        })
    );
    fx.season = season_bytes(SL::STATUS_ENDED, WIDE_VERSION);
    assert!(fx.plan().is_ok(), "Ended still settles");
    fx.season = season_ok();
    // A host of another world: BadAddress.
    let foreign = WideHostRef::new(key(other_world(), 129, 0), SITE, GEN, 7).unwrap();
    let r = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        foreign,
        SLOT,
        &fx.reads(),
    ));
    assert_eq!(r, Err(Block::World));
    // A slot past the four.
    let r = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        4,
        &fx.reads(),
    ));
    assert_eq!(r, Err(Block::BadSlot(4)));
    // An account at the canonical address owned by another program.
    let mut reads = fx.reads();
    let mut a = acct(fx.holding.clone().unwrap()).unwrap();
    a.owner = Address::new_from_array([0x99; 32]);
    reads.accounts.insert(fx.holding_addr(), Some(a));
    assert_eq!(
        done(wideduty::plan_settle_departure(
            &dscope(),
            payer(),
            host(),
            SLOT,
            &reads
        )),
        Err(Block::ForeignOwner("holding"))
    );
}

#[test]
fn settle_plan_requires_the_pinned_deployment_and_judges_seeded_only_by_the_observed_clock() {
    let fx = SettleFx::new(home());
    // No pin: blocked, never "any version with the wide bit".
    let unpinned = wideduty::Scope {
        deployment: None,
        ..dscope()
    };
    assert_eq!(fx.plan_in(&unpinned), Err(Block::DeploymentUnpinned));
    // A pin of another version (the wide bit set on another base).
    let other_version = wideduty::Scope {
        deployment: Some(Deployment {
            program_version: (frontier_abi::v2::presets::PROGRAM_VERSION_S1 + 1)
                | wix::WIDE_EXPERIMENTAL_VERSION_BIT,
            ruleset_hash: RULESET,
        }),
        ..dscope()
    };
    assert_eq!(
        fx.plan_in(&other_version),
        Err(Block::ProgramVersion {
            expected: (frontier_abi::v2::presets::PROGRAM_VERSION_S1 + 1)
                | wix::WIDE_EXPERIMENTAL_VERSION_BIT,
            got: WIDE_VERSION
        })
    );
    // A pin of another ruleset hash.
    let other_hash = wideduty::Scope {
        deployment: Some(Deployment {
            program_version: WIDE_VERSION,
            ruleset_hash: [0x78; 32],
        }),
        ..dscope()
    };
    assert_eq!(fx.plan_in(&other_hash), Err(Block::RulesetHash));
    // The Season carries another hash than the pin.
    let mut fx2 = SettleFx::new(home());
    fx2.season = season_with(SL::STATUS_RUNNING, WIDE_VERSION, [0x79; 32]);
    assert_eq!(fx2.plan(), Err(Block::RulesetHash));
    // A pin without the wide bit (the Season matching it): not a wide build.
    let plain = frontier_abi::v2::presets::PROGRAM_VERSION_S1;
    fx2.season = season_bytes(SL::STATUS_RUNNING, plain);
    let plain_scope = wideduty::Scope {
        deployment: Some(Deployment {
            program_version: plain,
            ruleset_hash: RULESET,
        }),
        ..dscope()
    };
    assert!(matches!(fx2.plan_in(&plain_scope), Err(Block::Season(_))));
    // Stored Seeded: no clock → blocked; clock before genesis → not
    // started; clock at genesis → Running by the handler's rule, and the
    // candidate says the status came from a non-coherent observation.
    let mut fx = SettleFx::new(home());
    fx.season = season_bytes(SL::STATUS_SEEDED, WIDE_VERSION);
    assert_eq!(fx.plan(), Err(Block::SeasonDependsOnClock));
    let mut reads = fx.reads();
    reads.clock = Some(clock_at(GENESIS_TS - 1));
    assert_eq!(
        done(wideduty::plan_settle_departure(
            &dscope(),
            payer(),
            host(),
            SLOT,
            &reads
        )),
        Err(Block::SeasonNotStarted {
            genesis_ts: GENESIS_TS,
            observed: GENESIS_TS - 1
        })
    );
    reads.clock = Some(clock_at(GENESIS_TS));
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert!(c.status_promoted_by_clock);
    assert!(!c.coherent());
    assert_eq!(c.describe()["status_promoted_by_clock"], true);
    // Running needs no clock and is not "promoted".
    let fx = SettleFx::new(home());
    let mut reads = fx.reads();
    reads.clock = Some(clock_at(GENESIS_TS - 1));
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert!(!c.status_promoted_by_clock);
}

#[test]
fn settle_plan_predicts_the_stored_values_and_refuses_chains_without_headroom() {
    // Destroyed (kernel troops below 500): zero troops and zero stamina
    // are what the record stores; the kernel values are kept beside them.
    let mut fx = SettleFx::new(home());
    let (_, aliases) = roster_bytes(home(), &[(4, host())]);
    let mut e = entry(aliases[0], E::STATE_DEPARTED, EntryOp::None, 2, 400);
    e.ready_bell = DEPART_BELL + 5;
    write_entry(&mut fx.province, 4, &e).unwrap();
    let c = fx.plan().unwrap();
    let Duty::SettleDeparture(f) = &c.duty else {
        panic!("a settle");
    };
    assert_eq!((f.kernel_troops_milli, f.predicted_destroyed), (400, true));
    assert_eq!((f.troops_after_milli, f.stamina_after), (0, 0));
    assert_eq!(f.ready_bell_off, 5);
    // `ready_bell_off` saturates at u16::MAX and at 0.
    let mut fx = SettleFx::new(home());
    let mut e = entry(aliases[0], E::STATE_DEPARTED, EntryOp::None, 2, TROOPS);
    e.ready_bell = u32::MAX;
    write_entry(&mut fx.province, 4, &e).unwrap();
    let c = fx.plan().unwrap();
    let Duty::SettleDeparture(f) = &c.duty else {
        panic!("a settle");
    };
    assert_eq!(f.ready_bell_off, u16::MAX);
    assert_eq!(
        (f.troops_after_milli, f.stamina_after),
        (TROOPS, f.kernel_stamina)
    );
    let mut fx = SettleFx::new(home());
    let mut e = entry(aliases[0], E::STATE_DEPARTED, EntryOp::None, 2, TROOPS);
    e.ready_bell = DEPART_BELL - 1;
    write_entry(&mut fx.province, 4, &e).unwrap();
    let c = fx.plan().unwrap();
    let Duty::SettleDeparture(f) = &c.duty else {
        panic!("a settle");
    };
    assert_eq!(f.ready_bell_off, 0);
    // The DepartureSettled record chains the origin and the holding once:
    // a chain at `u64::MAX` cannot take it.
    let mut fx = SettleFx::new(home());
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX));
    assert_eq!(fx.plan(), Err(Block::ChainOverflow("origin_province")));
    let mut fx = SettleFx::new(home());
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX - 1));
    assert!(fx.plan().is_ok(), "one step of headroom suffices");
    let mut fx = SettleFx::new(home());
    let hd = fx.holding.as_mut().unwrap();
    assert!(wr_u64(hd, header::EVENT_SEQ, u64::MAX));
    assert_eq!(fx.plan(), Err(Block::ChainOverflow("holding")));
}

// ------------------------------------------------------------ return fixture

/// A WideReturn of the hosts of the home holding standing in `standing`.
struct ReturnFx {
    standing: ProvinceKey,
    season: Vec<u8>,
    province: Vec<u8>,
    roster: Vec<u8>,
    holding: Option<Vec<u8>>,
    transits: [Option<Vec<u8>>; 4],
    /// The holding's own province, when it is not `standing`.
    own: Option<Vec<u8>>,
}
impl ReturnFx {
    /// `hosts` are departed Leave entries at indices 2, 3, …; each a host
    /// of the home holding unless stated.
    fn new(standing: ProvinceKey, hosts: &[WideHostRef]) -> ReturnFx {
        let refs: Vec<(usize, WideHostRef)> =
            hosts.iter().enumerate().map(|(k, h)| (k + 2, *h)).collect();
        let (roster, aliases) = roster_bytes(standing, &refs);
        let mut province = province_bytes(standing, DEPART_BELL + 1);
        for (k, a) in aliases.iter().enumerate() {
            put_entry(
                &mut province,
                k + 2,
                &entry(*a, E::STATE_DEPARTED, EntryOp::Leave, 2, TROOPS),
            );
        }
        let own = (standing != home()).then(|| province_bytes(home(), DEPART_BELL + 1));
        ReturnFx {
            standing,
            season: season_ok(),
            province,
            roster,
            holding: Some(holding_bytes(
                home().coord(),
                GEN,
                H::STATE_FINAL,
                citizen(),
            )),
            transits: [None, None, None, None],
            own,
        }
    }
    fn holding_addr(&self) -> Address {
        holding_addr(home().coord(), SITE)
    }
    fn transit_addrs(&self) -> [Address; 4] {
        std::array::from_fn(|s| transit_addr(self.holding_addr(), s as u8))
    }
    fn reads(&self) -> Reads {
        let mut v = vec![
            (season_pda().0, acct(self.season.clone())),
            (province_addr(self.standing), acct(self.province.clone())),
            (roster_addr(self.standing), acct(self.roster.clone())),
            (self.holding_addr(), self.holding.clone().and_then(acct)),
        ];
        for (a, t) in self.transit_addrs().iter().zip(self.transits.iter()) {
            v.push((*a, t.clone().and_then(acct)));
        }
        if self.standing != home() {
            v.push((province_addr(home()), self.own.clone().and_then(acct)));
        }
        reads_of(v)
    }
    fn plan(&self) -> Result<Candidate, Block> {
        done(wideduty::plan_return(
            &dscope(),
            payer(),
            self.standing,
            host().holding_ref(),
            &self.reads(),
        ))
    }
    fn expected_accounts(&self, tenth: bool) -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new(payer(), true),
            AccountMeta::new_readonly(season_pda().0, false),
            AccountMeta::new(province_addr(self.standing), false),
            AccountMeta::new(roster_addr(self.standing), false),
            AccountMeta::new(self.holding_addr(), false),
        ];
        for a in self.transit_addrs() {
            v.push(AccountMeta::new_readonly(a, false));
        }
        if tenth {
            v.push(AccountMeta::new_readonly(province_addr(home()), false));
        }
        v
    }
}

fn return_facts(c: &Candidate) -> &wideduty::ReturnFacts {
    match &c.duty {
        Duty::Return(f) => f,
        other => panic!("a return, not {other:?}"),
    }
}

#[test]
fn return_plan_credits_a_live_holding_at_the_reference_generation_and_strands_otherwise() {
    // Live, final, at generation 1 = the reference's: credited.
    let fx = ReturnFx::new(home(), &[host()]);
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction.program_id, program());
    assert_eq!(c.instruction.accounts, fx.expected_accounts(false));
    assert_eq!(c.instruction.data, Return.to_bytes().to_vec());
    let f = return_facts(&c);
    assert!(f.holding_present && !f.foreign);
    assert_eq!(f.live_gen, Some(GEN));
    assert_eq!(f.picks.len(), 1);
    assert_eq!(
        (
            f.picks[0].entry_index,
            f.picks[0].host,
            f.picks[0].credited,
            f.picks[0].whole_troops
        ),
        (2, host(), true, TROOPS / 1_000)
    );
    assert!(!c.signed && !c.automatic_send && !c.coherent());
    // The site re-founded at generation 2 (a transfer, a new owner): the
    // return still plans; the troops strand.
    let mut fx = ReturnFx::new(home(), &[host()]);
    fx.holding = Some(holding_bytes(
        home().coord(),
        GEN + 1,
        H::STATE_FINAL,
        [0xC2; 32],
    ));
    let c = fx.plan().unwrap();
    let f = return_facts(&c);
    assert_eq!((f.holding_present, f.live_gen), (true, Some(GEN + 1)));
    assert!(!f.picks[0].credited);
    // A released holding record at the reference generation: not live, strands.
    fx.holding = Some(holding_bytes(
        home().coord(),
        GEN,
        H::STATE_RELEASED,
        citizen(),
    ));
    let f = fx.plan().unwrap();
    let f = return_facts(&f);
    assert_eq!(f.live_gen, None);
    assert!(!f.picks[0].credited);
    // The holding absent: the position is still its canonical address,
    // nine accounts, the hosts strand.
    fx.holding = None;
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction.accounts, fx.expected_accounts(false));
    let f = return_facts(&c);
    assert!(!f.holding_present && f.live_gen.is_none() && !f.picks[0].credited);
}

#[test]
fn return_plan_adds_the_tenth_account_for_a_foreign_holding_and_reads_its_lock_there() {
    // Hosts of the home holding standing in `away`: the holding's own
    // province is the tenth account, where the capture lock is read.
    let fx = ReturnFx::new(away(), &[host()]);
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction.accounts, fx.expected_accounts(true));
    assert_eq!(c.instruction.accounts.len(), 10);
    let f = return_facts(&c);
    assert!(f.foreign && f.picks[0].credited);
    // Not read yet: the planner asks for exactly it.
    let mut reads = fx.reads();
    reads.accounts.remove(&province_addr(home()));
    let s = wideduty::plan_return(&dscope(), payer(), away(), host().holding_ref(), &reads);
    assert_eq!(s, Step::Need(vec![province_addr(home())]));
    // Absent: the handler's BadAccount.
    let mut fx = ReturnFx::new(away(), &[host()]);
    fx.own = None;
    assert_eq!(fx.plan(), Err(Block::Absent("holding_province")));
    // Capture-locked in the own province: refused there, not in `away`.
    let mut fx = ReturnFx::new(away(), &[host()]);
    let s = PV2::site(SITE as usize);
    let own = fx.own.as_mut().unwrap();
    own[s + SM::STATE] = SM::STATE_HOLDING;
    own[s + SM::GEN] = GEN + 1;
    assert_eq!(fx.plan(), Err(Block::CapturePending));
    // The same mirror state in the standing province is not the holding's lock.
    let mut fx = ReturnFx::new(away(), &[host()]);
    fx.province[s + SM::STATE] = SM::STATE_HOLDING;
    fx.province[s + SM::GEN] = GEN + 1;
    assert!(fx.plan().is_ok());
    // An absent holding standing abroad: no lock to read, no tenth account.
    let mut fx = ReturnFx::new(away(), &[host()]);
    fx.holding = None;
    fx.own = None;
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction.accounts.len(), 9);
    assert!(!return_facts(&c).foreign);
}

#[test]
fn return_plan_reads_all_four_transit_positions_and_settles_at_most_return_max_in_entry_order() {
    let hosts: Vec<WideHostRef> = (7..11u32)
        .map(|seq| WideHostRef::new(home(), SITE, GEN, seq).unwrap())
        .collect();
    // Four departed Leave entries: three settle, in entry order.
    let fx = ReturnFx::new(home(), &hosts);
    let c = fx.plan().unwrap();
    let f = return_facts(&c);
    assert_eq!(f.picks.len(), RETURN_MAX);
    assert_eq!(
        f.picks.iter().map(|p| p.entry_index).collect::<Vec<_>>(),
        vec![2, 3, 4]
    );
    // A present transit record (any state) in slot 3 for the first host:
    // it is skipped, the others return.
    let mut fx = ReturnFx::new(home(), &hosts);
    fx.transits[3] = Some(transit_bytes(hosts[0], home(), true, root()));
    let c = fx.plan().unwrap();
    let f = return_facts(&c);
    assert_eq!(f.skipped_in_transit, 1);
    assert_eq!(
        f.picks.iter().map(|p| p.entry_index).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    // The only returnable host has an open march in slot 0: HostInTransit.
    let mut fx = ReturnFx::new(home(), &[host()]);
    fx.transits[0] = Some(transit_bytes(host(), home(), false, root()));
    assert_eq!(fx.plan(), Err(Block::HostInTransit));
    // No departed Leave entry names this holding: AlreadyDone.
    let fx = ReturnFx::new(home(), &[]);
    assert_eq!(fx.plan(), Err(Block::NothingToReturn));
    // A Leave entry of another holding's host (site 4) is not this return's.
    let other = WideHostRef::new(home(), 4, GEN, 1).unwrap();
    let fx = ReturnFx::new(home(), &[other]);
    assert_eq!(fx.plan(), Err(Block::NothingToReturn));
    // No roster: AlreadyDone.
    let mut reads = ReturnFx::new(home(), &[host()]).reads();
    reads.accounts.insert(roster_addr(home()), None);
    assert_eq!(
        done(wideduty::plan_return(
            &dscope(),
            payer(),
            home(),
            host().holding_ref(),
            &reads
        )),
        Err(Block::NoRoster)
    );
    // A credit that would overflow the reserve.
    let mut fx = ReturnFx::new(home(), &[host()]);
    let hd = fx.holding.as_mut().unwrap();
    assert!(wr_u32(hd, H::reserve(2), u32::MAX));
    assert_eq!(fx.plan(), Err(Block::ReserveOverflow { unit: 2 }));
    // A transit position holding undecodable bytes: BadAccount.
    let mut fx = ReturnFx::new(home(), &[host()]);
    fx.transits[2] = Some(vec![0u8; 288]);
    assert_eq!(fx.plan(), Err(Block::Unreadable("transit")));
}

#[test]
fn return_plan_refuses_event_chains_without_room_for_every_record_it_would_log() {
    let two: Vec<WideHostRef> = (7..9u32)
        .map(|seq| WideHostRef::new(home(), SITE, GEN, seq).unwrap())
        .collect();
    // Two picks: the province chain takes two records; `MAX − 1` has room
    // for one only.
    let mut fx = ReturnFx::new(home(), &two);
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX - 1));
    assert_eq!(fx.plan(), Err(Block::ChainOverflow("province")));
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX - 2));
    assert!(fx.plan().is_ok());
    // The holding chain takes one record per credited entry.
    let mut fx = ReturnFx::new(home(), &two);
    let hd = fx.holding.as_mut().unwrap();
    assert!(wr_u64(hd, header::EVENT_SEQ, u64::MAX - 1));
    assert_eq!(fx.plan(), Err(Block::ChainOverflow("holding")));
    // Stranded entries (holding at another generation) chain the province
    // only: the holding chain at `MAX` is not touched.
    let mut fx = ReturnFx::new(home(), &two);
    fx.holding = Some(holding_bytes(
        home().coord(),
        GEN + 1,
        H::STATE_FINAL,
        [0xC2; 32],
    ));
    let hd = fx.holding.as_mut().unwrap();
    assert!(wr_u64(hd, header::EVENT_SEQ, u64::MAX));
    let c = fx.plan().unwrap();
    assert!(return_facts(&c).picks.iter().all(|p| !p.credited));
    // An absent holding: only the province chain is checked.
    let mut fx = ReturnFx::new(home(), &two);
    fx.holding = None;
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX - 2));
    assert!(fx.plan().is_ok());
    assert!(wr_u64(&mut fx.province, header::EVENT_SEQ, u64::MAX - 1));
    assert_eq!(fx.plan(), Err(Block::ChainOverflow("province")));
}

#[test]
fn return_plan_refuses_the_legacy_wide_boundary_and_other_worlds() {
    // A legacy Province v2 at the standing position: not a wide province.
    let mut fx = ReturnFx::new(home(), &[host()]);
    fx.province = legacy_province_bytes();
    assert_eq!(fx.plan(), Err(Block::Unreadable("province")));
    // A standing key of another world.
    let fx = ReturnFx::new(home(), &[host()]);
    let r = done(wideduty::plan_return(
        &dscope(),
        payer(),
        key(other_world(), 129, 0),
        host().holding_ref(),
        &fx.reads(),
    ));
    assert_eq!(r, Err(Block::World));
    // A wide province of this world at the wrong address (the holding's
    // own province bytes at the standing position): not canonical.
    let mut fx = ReturnFx::new(away(), &[host()]);
    fx.province = province_bytes(home(), DEPART_BELL + 1);
    assert_eq!(fx.plan(), Err(Block::NotCanonical("province")));
}

// ------------------------------------------------------------ the port

struct FakePort {
    accounts: BTreeMap<Address, Option<Account>>,
    min_slots: Mutex<Vec<u64>>,
    forbidden: AtomicUsize,
}

impl ChainPort for FakePort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(ClockSysvar {
            slot: 900,
            unix_timestamp: 1_790_444_847,
            ..ClockSysvar::default()
        })
    }
    fn accounts(
        &self,
        keys: &[Address],
        min_slot: u64,
    ) -> impl Future<Output = PortResult<Vec<Option<Account>>>> + Send {
        self.min_slots.lock().unwrap().push(min_slot);
        let out: Vec<Option<Account>> = keys
            .iter()
            .map(|k| self.accounts.get(k).cloned().flatten())
            .collect();
        async move { Ok(out) }
    }
    fn simulate(&self, _tx: &[u8]) -> impl Future<Output = PortResult<SimResult>> + Send {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        async { Err(PortError::Unsupported("simulate is forbidden here")) }
    }
    fn send(&self, _tx: &[u8]) -> impl Future<Output = PortResult<Signature>> + Send {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        async { Err(PortError::Unsupported("send is forbidden here")) }
    }
    async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(vec![])
    }
    async fn feed(&self, _after: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::default(), 0))
    }
}

fn block_on<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(f)
}

#[test]
fn the_driver_reads_through_the_port_at_the_requested_bound_and_never_simulates_or_sends() {
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let c = block_on(wideduty::settle_departure_via(
        &port,
        &dscope(),
        payer(),
        host(),
        SLOT,
        777,
    ))
    .unwrap();
    assert_eq!(c.instruction, fx.expected_instruction());
    assert_eq!(c.min_slot, 777);
    assert_eq!(c.observed_clock.map(|c| c.slot), Some(900));
    assert!(
        !c.coherent(),
        "a separately observed clock is never coherent"
    );
    assert_eq!(*port.min_slots.lock().unwrap(), vec![777, 777]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // A return through the port, foreign (three read rounds).
    let fx = ReturnFx::new(away(), &[host()]);
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let c = block_on(wideduty::return_via(
        &port,
        &dscope(),
        payer(),
        away(),
        host().holding_ref(),
        5,
    ))
    .unwrap();
    assert_eq!(c.instruction.accounts, fx.expected_accounts(true));
    assert_eq!(*port.min_slots.lock().unwrap(), vec![5, 5]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // A port that answers nothing: the plan blocks on the absent Season,
    // it does not invent one.
    let port = FakePort {
        accounts: BTreeMap::new(),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let r = block_on(wideduty::settle_departure_via(
        &port,
        &dscope(),
        payer(),
        host(),
        SLOT,
        1,
    ));
    assert_eq!(r, Err(Block::Absent("season")));
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------ the proof

fn budget() -> TxBudget {
    TxBudget {
        cu_limit: 200_000,
        cu_price: 0,
        loaded_limit: 1_048_576,
        heap: None,
    }
}

/// The Depart data the dispatcher decodes.
fn depart() -> Depart {
    Depart {
        host: host().to_bytes(),
        transit_slot: SLOT,
        arrive_bell: ARRIVE_BELL,
        tip: TIP,
        commit: COMMIT,
        seal: seal(),
    }
}

/// The `DEPART` account list for `host()` standing in `standing`, the
/// departing slot writable.
fn depart_accounts(standing: ProvinceKey) -> Vec<AccountMeta> {
    let hk = holding_addr(home().coord(), SITE);
    let mut v = vec![
        AccountMeta::new_readonly(actor(), true),
        AccountMeta::new(payer(), true),
        AccountMeta::new_readonly(season_pda().0, false),
        AccountMeta::new(addr(citizen()), false),
        AccountMeta::new(hk, false),
        AccountMeta::new(province_addr(standing), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
        AccountMeta::new_readonly(province_addr(home()), false),
    ];
    for s in 0..4u8 {
        let t = transit_addr(hk, s);
        v.push(if s == SLOT {
            AccountMeta::new(t, false)
        } else {
            AccountMeta::new_readonly(t, false)
        });
    }
    v.push(AccountMeta::new_readonly(roster_addr(standing), false));
    v
}

fn depart_ix(standing: ProvinceKey) -> Instruction {
    Instruction {
        program_id: program(),
        accounts: depart_accounts(standing),
        data: depart().to_bytes().to_vec(),
    }
}

fn act_ix(standing: ProvinceKey, proof_accounts: usize) -> Instruction {
    let inner = depart().to_bytes();
    let mut data = vec![0u8; ResidentAct::HEAD + inner.len()];
    ResidentAct {
        generation: 3,
        inner: &inner,
    }
    .encode_into(&mut data)
    .unwrap();
    let mut accounts = depart_accounts(standing);
    for k in 0..proof_accounts {
        accounts.push(AccountMeta::new_readonly(
            Address::new_from_array([0xD1 + k as u8; 32]),
            false,
        ));
    }
    Instruction {
        program_id: program(),
        accounts,
        data,
    }
}

/// An unsigned legacy transaction of `ixs` paid by `payer()` with literal
/// signature bytes in place of signatures (nothing is signed).
fn wire_of(ixs: &[Instruction]) -> Vec<u8> {
    let msg = tx::message(ixs, &budget(), &payer(), &Hash::new_from_array([7; 32]));
    let mut t = Transaction::new_unsigned(msg);
    let sigs = [SIG_PAYER, SIG_ACTOR];
    assert!(t.signatures.len() <= sigs.len());
    for (s, b) in t.signatures.iter_mut().zip(sigs.iter()) {
        *s = Signature::from(*b);
    }
    tx::wire(&t)
}

fn link(entity: WideEntity, seq: u64) -> WideLink {
    WideLink {
        entity,
        seq,
        head: [seq as u8; 32],
    }
}
fn both(kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(
        kind,
        bell,
        key,
        payload,
        &[link(WideEntity::Province, 1), link(WideEntity::Holding, 1)],
    )
    .unwrap()
}
#[allow(clippy::too_many_arguments)]
fn departed_body(
    h: WideHostRef,
    standing: ProvinceKey,
    bell: u32,
    slot: u8,
    depart_bell: u32,
    arrive: u32,
    tip: u64,
    root: [u8; 32],
) -> Vec<u8> {
    both(
        WideKind::Departed,
        bell,
        &wev::host_key(&h, standing),
        &wev::departed_payload(
            slot,
            depart_bell,
            arrive,
            TROOPS,
            61,
            tip,
            7_000,
            11_000,
            &root,
        ),
    )
}
fn departed_ok(standing: ProvinceKey) -> Vec<u8> {
    departed_body(
        host(),
        standing,
        DEPART_BELL,
        SLOT,
        DEPART_BELL,
        ARRIVE_BELL,
        TIP,
        root(),
    )
}
fn data_line(tag: &[u8], body: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b64.encode(tag), b64.encode(body))
}
fn frame(bodies: &[Vec<u8>]) -> Vec<String> {
    fclient::log::in_frame(&program(), bodies.iter().map(|b| data_line(b"PSW1", b)))
}
fn record(wire: Vec<u8>, logs: Vec<String>) -> TxRecord {
    TxRecord {
        seq: 11,
        slot: 1_011,
        signature: Signature::from(SIG_PAYER),
        block_time: 0,
        tx: wire,
        logs,
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

#[test]
fn proof_binds_the_commitment_and_seal_of_a_plain_depart_to_its_departed_record() {
    let rec = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    let p = depart_proof(&rec, &scope()).unwrap();
    assert_eq!((p.host, p.standing, p.transit_slot), (host(), home(), SLOT));
    assert_eq!(
        (p.depart_bell, p.arrive_bell, p.tip),
        (DEPART_BELL, ARRIVE_BELL, TIP)
    );
    assert_eq!((p.commit, p.seal_root), (COMMIT, root()));
    assert_eq!(p.seal[..], seal()[..]);
    // The escrow facts come from the record, never the wire.
    assert_eq!(
        (p.dep_mass_milli, p.march_stamina, p.fee, p.bond),
        (TROOPS, 61, 7_000, 11_000)
    );
    let hk = holding_addr(home().coord(), SITE);
    assert_eq!(p.holding, hk);
    assert_eq!(p.transit, transit_addr(hk, SLOT));
    assert_eq!(p.origin_province, province_addr(home()));
    assert_eq!(p.roster, roster_addr(home()));
    assert!(!p.act_wrapped);
    assert_eq!((p.provenance.seq, p.provenance.slot), (11, 1_011));
    assert_eq!(p.provenance.signature, SIG_PAYER);
    assert!(
        !p.provenance.signatures_verified,
        "no signature is verified here"
    );
    // The budget prefix occupies three instructions; the Depart is the fourth.
    assert_eq!(p.provenance.instruction_index, 3);
    // Standing away from home: the standing and roster positions follow
    // the record's standing key, the holding_province stays home.
    let rec = record(wire_of(&[depart_ix(away())]), frame(&[departed_ok(away())]));
    let p = depart_proof(&rec, &scope()).unwrap();
    assert_eq!(p.standing, away());
    assert_eq!(p.origin_province, province_addr(away()));
    assert_eq!(p.roster, roster_addr(away()));
    // A page helper reports every record, failures included.
    let bad = record(vec![], vec![]);
    let out = keeper_core::wideproof::depart_proofs(&[rec, bad], &scope());
    assert!(out[0].1.is_ok());
    assert_eq!(out[1].1, Err(Unavailable::NoWire));
}

#[test]
fn proof_unwraps_a_resident_act_only_with_exactly_four_readonly_proof_accounts() {
    let rec = record(wire_of(&[act_ix(home(), 4)]), frame(&[departed_ok(home())]));
    let p = depart_proof(&rec, &scope()).unwrap();
    assert!(p.act_wrapped);
    assert_eq!(
        (p.commit, p.seal_root, p.transit_slot),
        (COMMIT, root(), SLOT)
    );
    // Three proof accounts: not the dispatcher's shape.
    let rec = record(wire_of(&[act_ix(home(), 3)]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("account count"))
    );
    // A writable proof account.
    let mut ix = act_ix(home(), 4);
    ix.accounts[13].is_writable = true;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts(
            "a proof account is signed or writable"
        ))
    );
    // An act whose inner is not a Depart (a Muster envelope): no Depart.
    let mut data = vec![wix::TAG_RESIDENT_ACT, 0, 0, 0, 0];
    data.extend_from_slice(
        &wix::Muster {
            unit: 0,
            troops: 1_000,
            tile: 1,
        }
        .to_bytes(),
    );
    let ix = Instruction {
        program_id: program(),
        accounts: depart_accounts(home()),
        data,
    };
    let rec = record(wire_of(&[ix]), frame(&[]));
    assert_eq!(depart_proof(&rec, &scope()), Err(Unavailable::NoDepart));
}

#[test]
fn proof_is_unavailable_on_rollback_missing_or_non_canonical_wire() {
    let good = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    assert!(depart_proof(&good, &scope()).is_ok());
    // A failed transaction: nothing it logged is an event.
    let mut r = good.clone();
    r.err = Some("custom program error: 0x33".into());
    assert_eq!(depart_proof(&r, &scope()), Err(Unavailable::RolledBack));
    // No wire bytes (a public RPC feed).
    let mut r = good.clone();
    r.tx.clear();
    assert_eq!(depart_proof(&r, &scope()), Err(Unavailable::NoWire));
    // The wire of another record.
    let mut r = good.clone();
    r.signature = Signature::from([0x53; 64]);
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::SignatureMismatch)
    );
    // Trailing bytes: not the canonical encoding.
    let mut r = good.clone();
    r.tx.push(0);
    assert!(matches!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed(_))
    ));
    // The header's signature count raised past the signatures present
    // (byte after the short-vec length and two 64-byte signatures).
    let mut r = good.clone();
    assert_eq!(r.tx[0], 2, "two signatures");
    r.tx[1 + 2 * 64] = 3;
    assert!(matches!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed(_)) | Err(Unavailable::Wire(_))
    ));
    // Garbage.
    let mut r = good.clone();
    r.tx = vec![0xFF; 10];
    assert!(matches!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Wire(_)) | Err(Unavailable::Malformed(_))
    ));
}

#[test]
fn proof_requires_exactly_one_departed_inside_the_depart_instructions_own_frame() {
    let w = wire_of(&[depart_ix(home())]);
    // No Departed in the frame.
    let rec = record(w.clone(), frame(&[]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::DepartedCount(0))
    );
    // Two.
    let rec = record(
        w.clone(),
        frame(&[departed_ok(home()), departed_ok(home())]),
    );
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::DepartedCount(2))
    );
    // The program invoked below depth 1: unavailable, whatever it logged.
    let other = Address::new_from_array([0x0E; 32]);
    let nested = vec![
        format!("Program {other} invoke [1]"),
        format!("Program {} invoke [2]", program()),
        data_line(b"PSW1", &departed_ok(home())),
        format!("Program {} success", program()),
        format!("Program {other} success"),
    ];
    let rec = record(w.clone(), nested);
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::NestedInvocation)
    );
    // Two depth-1 frames of the program, one instruction: no binding.
    let mut two = frame(&[departed_ok(home())]);
    two.extend(frame(&[]));
    let rec = record(w.clone(), two);
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::FrameCount {
            frames: 2,
            instructions: 1
        })
    );
    // Two program instructions (a Depart, then a legacy-tagged one) and two
    // frames: the Departed in the second frame is the other instruction's.
    let legacy = Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(payer(), true)],
        data: vec![0x01, 0, 0],
    };
    let w2 = wire_of(&[depart_ix(home()), legacy]);
    let mut logs = frame(&[]);
    logs.extend(frame(&[departed_ok(home())]));
    let rec = record(w2.clone(), logs);
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::DepartedCount(0))
    );
    // The same with the Departed in the first frame binds.
    let mut logs = frame(&[departed_ok(home())]);
    logs.extend(frame(&[]));
    let rec = record(w2, logs);
    assert!(depart_proof(&rec, &scope()).is_ok());
    // A foreign program's frame carrying a forged Departed beside ours:
    // not attributed; ours still needs its own.
    let mut logs = vec![
        format!("Program {other} invoke [1]"),
        data_line(b"PSW1", &departed_ok(home())),
        format!("Program {other} success"),
    ];
    logs.extend(frame(&[]));
    let rec = record(w.clone(), logs);
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::DepartedCount(0))
    );
    // A failed CPI below our frame drops what it logged, not what we logged.
    let logs = vec![
        format!("Program {} invoke [1]", program()),
        data_line(b"PSW1", &departed_ok(home())),
        format!("Program {other} invoke [2]"),
        format!("Program {other} failed: custom program error: 0x1"),
        format!("Program {} success", program()),
    ];
    let rec = record(w.clone(), logs);
    assert!(depart_proof(&rec, &scope()).is_ok());
    // Truncated logs.
    let mut logs = frame(&[departed_ok(home())]);
    logs.insert(1, "Log truncated".into());
    let rec = record(w.clone(), logs);
    assert_eq!(depart_proof(&rec, &scope()), Err(Unavailable::Truncated));
    // A failed top-level frame with `err: None`: inconsistent, refused.
    let logs = vec![
        format!("Program {} invoke [1]", program()),
        format!("Program {} failed: custom program error: 0x1", program()),
    ];
    let rec = record(w.clone(), logs);
    assert!(matches!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Frame(_))
    ));
    // Two Departs in one transaction: this slice binds one.
    let rec = record(
        wire_of(&[depart_ix(home()), depart_ix(home())]),
        [frame(&[departed_ok(home())]), frame(&[departed_ok(home())])].concat(),
    );
    // Two sealed instructions in this fixture exceed the supported packet;
    // reject before allocating/decoding, rather than weakening the bound.
    assert!(rec.tx.len() > keeper_core::wideproof::MAX_WIRE_BYTES);
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Malformed(
            "wire exceeds the transaction packet size"
        ))
    );
}

#[test]
fn proof_refuses_every_field_account_or_world_mismatch() {
    let w = wire_of(&[depart_ix(home())]);
    let case = |body: Vec<u8>| depart_proof(&record(w.clone(), frame(&[body])), &scope());
    // The record's root is not the wire's `sha256(commit ‖ sha256(seal))`.
    assert_eq!(
        case(departed_body(
            host(),
            home(),
            DEPART_BELL,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP,
            [0xAB; 32]
        )),
        Err(Unavailable::Mismatch("seal root"))
    );
    assert_eq!(
        case(departed_body(
            host(),
            home(),
            DEPART_BELL,
            2,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP,
            root()
        )),
        Err(Unavailable::Mismatch("transit slot"))
    );
    assert_eq!(
        case(departed_body(
            host_b(),
            home(),
            DEPART_BELL,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP,
            root()
        )),
        Err(Unavailable::Mismatch("host reference"))
    );
    assert_eq!(
        case(departed_body(
            host(),
            home(),
            DEPART_BELL,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL + 1,
            TIP,
            root()
        )),
        Err(Unavailable::Mismatch("arrival bell"))
    );
    assert_eq!(
        case(departed_body(
            host(),
            home(),
            DEPART_BELL,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP + 1,
            root()
        )),
        Err(Unavailable::Mismatch("tip"))
    );
    // The record's header bell is not its departure bell.
    assert_eq!(
        case(departed_body(
            host(),
            home(),
            DEPART_BELL + 1,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP,
            root()
        )),
        Err(Unavailable::Mismatch("record bell and departure bell"))
    );
    // The record says the host stood in `away` but the wire's standing
    // and roster positions are home's: not canonical for the record.
    assert_eq!(
        case(departed_ok(away())),
        Err(Unavailable::Accounts(
            "standing province position is not canonical"
        ))
    );
    // A non-canonical holding position.
    let mut ix = depart_ix(home());
    ix.accounts[4].pubkey = Address::new_from_array([0xEE; 32]);
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("holding position is not canonical"))
    );
    // A transit position out of slot order.
    let mut ix = depart_ix(home());
    ix.accounts.swap(8, 10);
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("a transit position is not canonical"))
    );
    // The actor unsigned (the payer is the fee payer and always signs).
    let mut ix = depart_ix(home());
    ix.accounts[0].is_signer = false;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("a required signer is unsigned"))
    );
    // The Season position writable (a program-account read-only position).
    let mut ix = depart_ix(home());
    ix.accounts[2].is_writable = true;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("a read-only position is writable"))
    );
    // The same wire under another Season's scope: another world.
    let other_scope = ProofScope {
        program: program(),
        season: Address::new_from_array([0x24; 32]),
    };
    let rec = record(w.clone(), frame(&[departed_ok(home())]));
    assert_eq!(depart_proof(&rec, &other_scope), Err(Unavailable::World));
    // Under another program: the instruction is not that program's.
    let other_program = ProofScope {
        program: Address::new_from_array([0x25; 32]),
        season: season_pda().0,
    };
    assert_eq!(
        depart_proof(&rec, &other_program),
        Err(Unavailable::NoDepart)
    );
}

/// A Depart whose seal starts with `b0` (the record's root follows the seal).
fn depart_with_seal_flag(b0: u8) -> (Instruction, Vec<u8>) {
    let mut s = seal();
    s[0] = b0;
    let d = Depart {
        seal: s,
        ..depart()
    };
    let root = wseal::seal_root(&COMMIT, &wseal::ct_hash(&s));
    let ix = Instruction {
        program_id: program(),
        accounts: depart_accounts(home()),
        data: d.to_bytes().to_vec(),
    };
    (
        ix,
        departed_body(
            host(),
            home(),
            DEPART_BELL,
            SLOT,
            DEPART_BELL,
            ARRIVE_BELL,
            TIP,
            root,
        ),
    )
}

#[test]
fn proof_enforces_the_prologue_flags_under_both_authorities_and_accepts_wallet_aliases() {
    // The actor is also the payer: one signer, the actor position shares
    // the payer's writable key (a wallet position may be writable).
    let mut ix = depart_ix(home());
    ix.accounts[0].pubkey = payer();
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(rec.tx[0], 1, "one signature");
    let p = depart_proof(&rec, &scope()).unwrap();
    assert_eq!(p.commit, COMMIT);
    // The standing province is the holding's own: positions 5 (w) and 7
    // (r) share one writable key (an `Any` position may be writable). The
    // happy path above already is that case; state it.
    assert_eq!(p.origin_province, province_addr(home()));
    // Under an act the actor still signs (`depart_as` runs
    // `check_accounts(DEPART)`; the resident start needs both signatures).
    let mut ix = act_ix(home(), 4);
    ix.accounts[0].is_signer = false;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("a required signer is unsigned"))
    );
    // The departing slot's transit position must be writable, whatever the
    // table's `Either` says.
    let mut ix = depart_ix(home());
    ix.accounts[wix::DEPART_TRANSIT0 + SLOT as usize].is_writable = false;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts(
            "the departing transit position is read-only"
        ))
    );
    // Another slot's position writable too: the handler decides that
    // (`Either`); the proof does not refuse it.
    let mut ix = depart_ix(home());
    ix.accounts[wix::DEPART_TRANSIT0 + 2].is_writable = true;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert!(depart_proof(&rec, &scope()).is_ok());
    // The Citizen (a program-account `W` position) read-only: refused.
    let mut ix = depart_ix(home());
    ix.accounts[3].is_writable = false;
    let rec = record(wire_of(&[ix]), frame(&[departed_ok(home())]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Accounts("a writable position is read-only"))
    );
}

#[test]
fn proof_validates_every_program_record_through_the_typed_reader_first() {
    let w = wire_of(&[depart_ix(home())]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let bad_ps2 = format!(
        "Program data: {} {}",
        b64.encode(b"PS2"),
        b64.encode([0xFFu8; 10])
    );
    // A malformed PS2 line in the Depart's own frame.
    let logs = fclient::log::in_frame(
        &program(),
        [data_line(b"PSW1", &departed_ok(home())), bad_ps2.clone()],
    );
    let rec = record(w.clone(), logs);
    assert!(matches!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Records(_))
    ));
    // A malformed PS2 line in **another** frame of the program (a second,
    // legacy-tagged instruction): the whole transaction is refused.
    let legacy = Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(payer(), true)],
        data: vec![0x01, 0, 0],
    };
    let w2 = wire_of(&[depart_ix(home()), legacy]);
    let mut logs = frame(&[departed_ok(home())]);
    logs.extend(fclient::log::in_frame(&program(), [bad_ps2]));
    let rec = record(w2.clone(), logs);
    assert!(matches!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Records(_))
    ));
    // An unknown data tag in the other frame: refused the same way.
    let unknown = format!(
        "Program data: {} {}",
        b64.encode(b"XYZ1"),
        b64.encode([1u8; 4])
    );
    let mut logs = frame(&[departed_ok(home())]);
    logs.extend(fclient::log::in_frame(&program(), [unknown]));
    let rec = record(w2, logs);
    assert!(matches!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::Records(_))
    ));
    // A well-formed PS2 line beside the Departed is fine (it is not a
    // wide record; the Depart's frame still holds exactly one Departed).
    let k = frontier_abi::v2::log::AnyKind::V1(frontier_abi::log::Kind::ANCHOR);
    let kp = vec![0xABu8; k.key_len() + k.payload_len()];
    let ps2 = fclient::log::chain(1, fclient::abi::kind::ANCHOR, 3, &kp, &[]);
    let logs = fclient::log::in_frame(
        &program(),
        [
            fclient::log::log_line(&ps2.encode()),
            data_line(b"PSW1", &departed_ok(home())),
        ],
    );
    let rec = record(w, logs);
    assert!(depart_proof(&rec, &scope()).is_ok());
}

#[test]
fn proof_refuses_legacy_rings_bad_seal_flags_and_out_of_bound_inputs() {
    // A host inside the legacy disk (ring 100), its record consistent with
    // it: not a wide identity, whatever the PDAs say.
    let low = key(world(), 100, 0);
    let low_host = WideHostRef::new(low, SITE, GEN, 7).unwrap();
    let d = Depart {
        host: low_host.to_bytes(),
        ..depart()
    };
    let hk = holding_addr(low.coord(), SITE);
    let mut accounts = depart_accounts(low);
    accounts[4].pubkey = hk;
    accounts[7].pubkey = province_addr(low);
    for s in 0..4u8 {
        accounts[wix::DEPART_TRANSIT0 + s as usize].pubkey = transit_addr(hk, s);
    }
    let ix = Instruction {
        program_id: program(),
        accounts,
        data: d.to_bytes().to_vec(),
    };
    let body = departed_body(
        low_host,
        low,
        DEPART_BELL,
        SLOT,
        DEPART_BELL,
        ARRIVE_BELL,
        TIP,
        root(),
    );
    let rec = record(wire_of(&[ix]), frame(&[body]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::NotWide("host"))
    );
    // A wide host standing in a legacy-ring province.
    let rec = record(wire_of(&[depart_ix(low)]), frame(&[departed_ok(low)]));
    assert_eq!(
        depart_proof(&rec, &scope()),
        Err(Unavailable::NotWide("standing province"))
    );
    // The seal's flag byte: bit 7 must be set and bit 6 clear.
    for b0 in [0x00u8, 0x40, 0xC0, 0x7F] {
        let (ix, body) = depart_with_seal_flag(b0);
        let rec = record(wire_of(&[ix]), frame(&[body]));
        assert_eq!(
            depart_proof(&rec, &scope()),
            Err(Unavailable::Instruction("seal flag byte")),
            "flag byte {b0:#x}"
        );
    }
    let (ix, body) = depart_with_seal_flag(0xBF);
    let rec = record(wire_of(&[ix]), frame(&[body]));
    assert!(depart_proof(&rec, &scope()).is_ok());
    // Bounds before any decoder runs.
    let good = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    let mut r = good.clone();
    r.tx = vec![0u8; keeper_core::wideproof::MAX_WIRE_BYTES + 1];
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed(
            "wire exceeds the transaction packet size"
        ))
    );
    // A versioned message (top bit of the message's first byte).
    let mut r = good.clone();
    r.tx[1 + 2 * 64] |= 0x80;
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed("versioned message is not supported"))
    );
    // A signature count byte of zero, or with the continuation bit.
    let mut r = good.clone();
    r.tx[0] = 0;
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed("signature count byte"))
    );
    r.tx[0] = 0x80;
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed("signature count byte"))
    );
    // A duplicate account key: key 2 overwritten with key 1 (the header is
    // three bytes after the signatures, then the one-byte key count).
    let mut r = good.clone();
    let keys_at = 1 + 2 * 64 + 3 + 1;
    let k1 = r.tx[keys_at + 32..keys_at + 64].to_vec();
    r.tx[keys_at + 64..keys_at + 96].copy_from_slice(&k1);
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Malformed("duplicate account key"))
    );
    // Too many log lines, before any reader walks them.
    let mut r = good.clone();
    r.logs = vec!["Program log: x".to_owned(); keeper_core::wideproof::MAX_LOG_LINES + 1];
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Frame("too many log lines"))
    );
    // An over-long log line.
    let mut r = good.clone();
    r.logs.push(format!(
        "Program log: {}",
        "x".repeat(keeper_core::wideproof::MAX_LOG_LINE_BYTES)
    ));
    assert_eq!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Frame("log line too long"))
    );
    // Invocation deeper than the runtime allows.
    let other = Address::new_from_array([0x0E; 32]);
    let mut logs = Vec::new();
    for d in 1..=6 {
        logs.push(format!("Program {other} invoke [{d}]"));
    }
    for _ in 1..=6 {
        logs.push(format!("Program {other} success"));
    }
    logs.extend(frame(&[departed_ok(home())]));
    let r = record(good.tx.clone(), logs);
    assert!(matches!(
        depart_proof(&r, &scope()),
        Err(Unavailable::Frame(_))
    ));
}

// ------------------------------------------------------------ the observer tie

/// The bounded per-tick review the keeper runs when both the observer and
/// the review are enabled, exercised directly (a `Keeper` cannot be built
/// here: its constructor derives signing keys). The model offers one
/// settle hint; the step plans it through the fake port's ordinary reads,
/// reviews it against a real, empty `Engine`, records a summary, enqueues
/// nothing, and does not re-review within the refresh window.
#[test]
fn the_tick_review_plans_reviews_and_enqueues_nothing() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(review.candidates_per_tick, CANDIDATES_PER_TICK);
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        5_000,
        None,
        None,
    ));
    assert_eq!(made, 1, "one hint, one plan");
    assert_eq!((review.plans, review.candidates, review.blocked), (1, 1, 0));
    assert_eq!(
        *port.min_slots.lock().unwrap(),
        vec![5_000, 5_000],
        "two read rounds for a settle, each at the tick's slot as the lower bound"
    );
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(engine.pending_len(), 0, "nothing enqueued");
    let st = review.status();
    assert_eq!(st["mode"], "review-only");
    assert_eq!(st["automatic_writes"], false);
    assert_eq!(st["enqueued"], 0);
    assert_eq!(st["ledger"], 1);
    assert_eq!(st["hard_cap"], CANDIDATES_PER_TICK);
    let recent = st["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["outcome"], "candidate");
    let rv = &recent[0]["assessment"]["review"];
    assert_eq!(rv["admitted"], false);
    assert_eq!(rv["enqueued"], false);
    assert_eq!(
        rv["key"],
        format!(
            "wide-settle-departure:{}:{}:{}",
            hex::encode(world().as_bytes()),
            hex::encode(host().to_bytes()),
            SLOT
        ),
        "the settle subject key by full identity"
    );
    assert_eq!(rv["kind"], "wide-settle-departure");
    assert_eq!(rv["tag"], wix::TAG_SETTLE_TICKET);
    assert_eq!(rv["class"], "D");
    assert_eq!(
        recent[0]["candidate"]["coherent"], false,
        "ordinary reads on the tick path"
    );
    assert_eq!(
        recent[0]["candidate"]["payer"],
        Address::default().to_string(),
        "no payer drawn: the System Program placeholder in the unsigned instruction"
    );
    assert!(
        recent[0]["assessment"]["needs"]["funding"]
            .as_str()
            .unwrap()
            .contains("Unknown"),
        "the placeholder's balance is never funding"
    );
    assert_eq!(recent[0]["assessment"]["snapshot"], serde_json::Value::Null);
    let denials = rv["denials"].as_array().unwrap();
    assert!(denials.iter().any(|d| d == "NoCoherentSnapshot"));
    assert!(denials.iter().any(|d| d == "FundingUnknown"));
    assert!(denials.iter().any(|d| d == "SliceDoesNotEnqueue"));
    // No snapshot source and no reveal inputs: said so, with the exact
    // gaps named.
    assert_eq!(st["snapshot"]["source"], "absent");
    assert_eq!(st["snapshot"]["coherent_candidates"], 0);
    assert!(st["covers"]
        .as_str()
        .unwrap()
        .contains("no snapshot source"));
    assert!(st["covers"].as_str().unwrap().contains("no reveal hints"));
    assert_eq!(st["reveal"]["inputs_at_last_step"], false);
    assert_eq!(st["reveal"]["proofs"]["held"], 0);
    assert_eq!(st["payer"], PAYER_UNSET);
    let missing = st["missing"].as_array().unwrap();
    assert_eq!(missing.len(), 4);
    assert!(missing[0].as_str().unwrap().starts_with("snapshot source"));
    assert!(missing[1].as_str().unwrap().starts_with("reveal inputs"));
    assert!(missing[2].as_str().unwrap().starts_with("departure proofs"));
    assert!(missing[3].as_str().unwrap().starts_with("payer"));
    // Within the refresh window the same hint is not planned again.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        5_000 + 1,
        None,
        None,
    ));
    assert_eq!(made, 0);
    assert_eq!(*port.min_slots.lock().unwrap(), vec![5_000, 5_000]);
    // Past it, it is.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        5_000 + REFRESH_SLOTS,
        None,
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!(review.plans, 2);
    assert_eq!(engine.pending_len(), 0);
    // A hint the chain refuses (the transit absent) is recorded as blocked.
    let mut fx2 = SettleFx::new(home());
    fx2.transit = None;
    let port2 = FakePort {
        accounts: fx2.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let mut review2 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(
        block_on(review2.step(
            &port2,
            &engine,
            &model,
            program(),
            season_pda().0,
            1,
            None,
            None
        )),
        1
    );
    assert_eq!((review2.candidates, review2.blocked), (0, 1));
    let st2 = review2.status();
    assert_eq!(st2["recent"][0]["outcome"], "blocked");
    assert!(st2["recent"][0]["block"]
        .as_str()
        .unwrap()
        .contains("NoMarch"));
    // A port whose reads fail: recorded as a read error, the status still
    // composes, nothing is enqueued, the step returns.
    let failing = FailingPort;
    let mut review3 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(
        block_on(review3.step(
            &failing,
            &engine,
            &model,
            program(),
            season_pda().0,
            9,
            None,
            None
        )),
        1
    );
    assert!(
        !review3.status().to_string().contains("fixture RPC is down"),
        "the port's own error text never reaches the status"
    );
    assert_eq!(
        (review3.candidates, review3.blocked, review3.read_errors),
        (0, 1, 1)
    );
    let st3 = review3.status();
    assert_eq!(st3["recent"][0]["outcome"], "blocked");
    assert!(st3["recent"][0]["block"].as_str().unwrap().contains("Read"));
    assert_eq!(st3["read_errors"], 1);
    assert_eq!(engine.pending_len(), 0);
    // The hard cap holds whatever the public knob says, and the cursor
    // advances by the positions inspected: three hints, cap 2 → two plans
    // this tick (the first two), then the third next tick.
    let mut three = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    let third = WideHostRef::new(home(), SITE, GEN, 9).unwrap();
    three
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![
                departed_ok(home()),
                departed_body(
                    host_b(),
                    home(),
                    DEPART_BELL,
                    0,
                    DEPART_BELL,
                    ARRIVE_BELL,
                    TIP,
                    root(),
                ),
                departed_body(
                    third,
                    home(),
                    DEPART_BELL,
                    2,
                    DEPART_BELL,
                    ARRIVE_BELL,
                    TIP,
                    root(),
                ),
            ],
        })
        .unwrap();
    assert_eq!(wideduty::settle_candidates(&three).len(), 3);
    let mut review4 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    review4.candidates_per_tick = 99;
    assert_eq!(
        review4.cap(),
        CANDIDATES_PER_TICK,
        "the public knob cannot raise the cap"
    );
    let made = block_on(review4.step(
        &port2,
        &engine,
        &three,
        program(),
        season_pda().0,
        10,
        None,
        None,
    ));
    assert_eq!(made as usize, CANDIDATES_PER_TICK);
    assert_eq!(review4.status()["cursor"], CANDIDATES_PER_TICK);
    let made = block_on(review4.step(
        &port2,
        &engine,
        &three,
        program(),
        season_pda().0,
        11,
        None,
        None,
    ));
    assert_eq!(made, 1, "the third hint, not the first two again");
    assert_eq!(review4.status()["ledger"], 3);
    assert_eq!(engine.pending_len(), 0);
    // The duty fee review over ordinary reads: nothing is created by a
    // settle, the base fee is the one-signature assumption, rent and
    // funding unknown (no verified snapshot binds these reads).
    let c = fx.plan().unwrap();
    assert!(!c.coherent() && c.snapshot().is_none());
    let needs = widefees::duty_needs(&c, &fx.reads()).unwrap();
    assert!(needs.creates.is_empty());
    assert_eq!(needs.base_fee_lamports, Known::Known(5_000));
    assert!(matches!(needs.rent_lamports, Known::Unchecked(_)));
    assert!(matches!(needs.funding, Funding::Unknown(_)));
    assert_eq!(needs.snapshot_digest, None);
}

/// A publication source that serves nothing (and counts the asks).
struct NoPublications {
    asks: Vec<(u64, u64)>,
}
impl PublicationSource for NoPublications {
    fn publication<'a>(
        &'a mut self,
        round: u64,
        slot: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Option<Publication>> + Send + 'a>> {
        self.asks.push((round, slot));
        Box::pin(async { None })
    }
    fn label(&self) -> &'static str {
        "test: serves nothing"
    }
}

/// The proof store keeps what `wideproof` extracts from feed pages (and
/// what an orchestrator supplies), bounded, superseding by sequence; its
/// hints follow the model; the tick lists reveal hints only with reveal
/// inputs and records a reveal the beacon source cannot serve as
/// `PublicationMissing`, enqueuing nothing.
#[test]
fn the_proof_store_feeds_reveal_hints_only_with_inputs_and_blocks_without_a_publication() {
    let mut store = ProofStore::default();
    // A feed page: one committed WideDepart, one record without a wire.
    let page = vec![
        record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())])),
        record(vec![], vec![]),
    ];
    assert_eq!(store.observe_page(&page, &scope(), page.len()), 1);
    assert_eq!(
        (store.len(), store.from_feed, store.records_seen),
        (1, 1, 2)
    );
    let e = store.get(host(), SLOT).expect("stored");
    assert_eq!(e.origin, ORIGIN_FEED);
    assert_eq!(e.seq, 11);
    assert!(!e.proof.provenance.signatures_verified);
    // The same page again: an exact replay changes nothing.
    assert_eq!(store.observe_page(&page, &scope(), page.len()), 0);
    assert_eq!((store.len(), store.superseded), (1, 0));
    // A later record of the same (host, slot) supersedes; an earlier one
    // does not.
    let mut later = store.get(host(), SLOT).unwrap().proof.clone();
    later.provenance.seq = 12;
    assert!(store.supply(later));
    assert_eq!((store.superseded, store.supplied), (1, 1));
    assert_eq!(store.get(host(), SLOT).unwrap().origin, ORIGIN_SUPPLIED);
    let mut earlier = store.get(host(), SLOT).unwrap().proof.clone();
    earlier.provenance.seq = 5;
    assert!(!store.supply(earlier));
    assert_eq!(store.get(host(), SLOT).unwrap().seq, 12);
    // Bounded: the oldest sequence leaves first.
    let base = store.get(host(), SLOT).unwrap().proof.clone();
    for i in 0..MAX_PROOFS as u32 {
        let mut p = base.clone();
        p.host = WideHostRef::new(home(), SITE, GEN, 100 + i).unwrap();
        p.provenance.seq = 100 + i as u64;
        assert!(store.supply(p));
    }
    assert_eq!(store.len(), MAX_PROOFS);
    assert_eq!(store.evicted, 1);
    assert!(store.get(host(), SLOT).is_none(), "seq 12 was the oldest");
    assert_eq!(store.status()["held"], MAX_PROOFS);
    assert_eq!(store.status()["max"], MAX_PROOFS);
    // Hints follow the model: unknown host → hint; the march open and
    // unrevealed → hint; revealed → none; a later march in another slot →
    // none; settled → none.
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&page, &scope(), page.len()), 1);
    let empty = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test".into(),
        },
        Limits::default(),
    );
    assert_eq!(store.hints(&empty), vec![(host(), SLOT)]);
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
    assert_eq!(store.hints(&model), vec![(host(), SLOT)]);
    let mut revealed = model.clone();
    revealed
        .apply(&WideBatch {
            seq: 2,
            slot: 1_002,
            signature: "sig-2".into(),
            // A `Revealed` record carries no links (the ABI's shape).
            bodies: vec![encode(
                WideKind::Revealed,
                ARRIVE_BELL,
                &wev::host_key(&host(), home()),
                &wev::revealed_payload(SLOT, 0, 0, 33, 0, 0, TROOPS, false),
                &[],
            )
            .unwrap()],
        })
        .unwrap();
    assert!(store.hints(&revealed).is_empty(), "revealed: no hint");
    let mut other_slot = model.clone();
    other_slot
        .apply(&WideBatch {
            seq: 2,
            slot: 1_002,
            signature: "sig-2".into(),
            bodies: vec![departed_body(
                host(),
                home(),
                DEPART_BELL + 1,
                SLOT + 1,
                DEPART_BELL + 1,
                ARRIVE_BELL + 1,
                TIP,
                root(),
            )],
        })
        .unwrap();
    assert!(
        store.hints(&other_slot).is_empty(),
        "the host's latest march is another slot: superseded"
    );
    // The tick: without reveal inputs only the settle hint is listed;
    // with them (a season and a source that serves nothing) the reveal
    // hint is planned too and blocked at the publication gate, before
    // anything destination-bearing is read.
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(review.proofs.observe_page(&page, &scope(), page.len()), 1);
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        50,
        None,
        None,
    ));
    assert_eq!(made, 1, "no reveal inputs: the settle hint only");
    assert_eq!((review.reveal_plans, review.plans), (0, 1));
    let st = review.status();
    assert_eq!(st["reveal"]["inputs_at_last_step"], false);
    assert_eq!(st["reveal"]["proofs"]["held"], 1);
    assert_eq!(
        st["missing"].as_array().unwrap().len(),
        3,
        "proofs are held; snapshot, inputs and payer missing"
    );
    let season = Season::decode(&season_ok()).unwrap();
    let mut none = NoPublications { asks: vec![] };
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        50 + REFRESH_SLOTS,
        None,
        Some(RevealInputs {
            season: &season,
            beacon: &mut none,
            beneficiary: actor(),
        }),
    ));
    assert_eq!(made, 2, "the settle hint again and the reveal hint");
    assert_eq!(
        (
            review.reveal_plans,
            review.reveal_candidates,
            review.publications_missing
        ),
        (1, 0, 1)
    );
    let round = fclient::clock::SeasonClock::from_season(&season).tlock_round(ARRIVE_BELL);
    assert_eq!(none.asks, vec![(round, 50 + REFRESH_SLOTS)]);
    let st = review.status();
    assert_eq!(st["reveal"]["inputs_at_last_step"], true);
    let recent = st["recent"].as_array().unwrap();
    let reveal = recent
        .iter()
        .find(|r| r["hint"].as_str().unwrap().starts_with("reveal:"))
        .expect("the reveal entry");
    assert_eq!(reveal["outcome"], "blocked");
    assert_eq!(reveal["block"], "PublicationMissing");
    assert_eq!(reveal["publication_served"], false);
    assert_eq!(reveal["publication_round"], round);
    assert_eq!(reveal["proof_origin"], ORIGIN_FEED);
    assert_eq!(
        reveal["min_slot"], 1_011,
        "max(tick slot, proof slot): the proof's record landed at 1,011"
    );
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(st["enqueued"], 0);
    // A snapshot source passed to the step (the test's literal-JSON
    // `SnapshotPort`, a `SnapshotSource` through the blanket impl): the
    // duty is coherent at the response's context slot; the unset payer is
    // not in the request and its funding stays unknown.
    let lit = LiteralSnapshots::new(fx.reads().accounts);
    let mut review5 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review5.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!(
        (
            review5.candidates,
            review5.coherent,
            review5.snapshot_blocked
        ),
        (1, 1, 0)
    );
    assert_eq!(lit.calls.load(Ordering::SeqCst), 1);
    assert!(
        !lit.keys.lock().unwrap()[0].contains(&Address::default()),
        "the placeholder payer is not requested"
    );
    let st = review5.status();
    assert!(st["snapshot"]["source"]
        .as_str()
        .unwrap()
        .starts_with("SnapshotPort"));
    assert_eq!(st["snapshot"]["coherent_candidates"], 1);
    let r = &st["recent"][0];
    assert_eq!(r["candidate"]["coherent"], true);
    assert_eq!(r["snapshot"]["context_slot"], 900);
    assert_eq!(
        r["snapshot"]["min_slot"], 900,
        "the tick's slot is the snapshot's minContextSlot"
    );
    let denials = r["assessment"]["review"]["denials"].as_array().unwrap();
    assert!(!denials.iter().any(|d| d == "NoCoherentSnapshot"));
    assert!(denials.iter().any(|d| d == "SnapshotCurrencyUnknown"));
    assert!(
        denials.iter().any(|d| d == "FundingUnknown")
            && !denials.iter().any(|d| d == "FundingUnmet"),
        "no payer set: the placeholder's balance is never funding"
    );
    assert_eq!(r["assessment"]["review"]["admitted"], false);
    assert_eq!(engine.pending_len(), 0);
    // A stale response (the fake's context below the tick's slot) is a
    // recorded snapshot block, not a candidate from other reads; its
    // code is typed.
    let mut review6 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review6.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        901,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!(
        (
            review6.candidates,
            review6.blocked,
            review6.snapshot_blocked
        ),
        (0, 1, 1)
    );
    assert_eq!(
        review6.status()["recent"][0]["block"],
        "Snapshot(Stale(900,901))"
    );
}

/// The Rent sysvar a literal snapshot serves when one is requested (the
/// runtime's defaults, as literal numbers).
const RENT_FIXTURE: RentSysvar = RentSysvar {
    lamports_per_byte_year: 3_480,
    exemption_threshold: 2.0,
    burn_percent: 50,
};

/// A literal-JSON `SnapshotPort` over an account map (records the keys of
/// every request). A `SnapshotSource` through the blanket impl. The
/// response's Clock is at `clock_ts` (the genesis timestamp unless set);
/// the Rent rides along exactly when the request asks for it. The context
/// slot is 900 — or, with `serve_at_requested_slot`, the request's
/// `minContextSlot` when that is later (what a live RPC answers; a fixed
/// 900 is `Stale` for any plan at a later tick).
struct LiteralSnapshots {
    accounts: BTreeMap<Address, Option<Account>>,
    calls: AtomicUsize,
    keys: Mutex<Vec<Vec<Address>>>,
    /// Served instead of a response when set.
    error: Option<SnapshotError>,
    clock_ts: i64,
    rent: Option<RentSysvar>,
    serve_at_requested_slot: bool,
}
impl LiteralSnapshots {
    fn new(accounts: BTreeMap<Address, Option<Account>>) -> LiteralSnapshots {
        LiteralSnapshots {
            accounts,
            calls: AtomicUsize::new(0),
            keys: Mutex::new(vec![]),
            error: None,
            clock_ts: GENESIS_TS,
            rent: Some(RENT_FIXTURE),
            serve_at_requested_slot: false,
        }
    }
}
impl SnapshotPort for LiteralSnapshots {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<keeper_core::widesnapshot::Snapshot, SnapshotError>> + Send
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.keys.lock().unwrap().push(keys.to_vec());
        let slot = if self.serve_at_requested_slot {
            min_slot.max(900)
        } else {
            900
        };
        let r = match &self.error {
            Some(e) => Err(e.clone()),
            None => parse_snapshot_response(
                &snapshot_json_rent(
                    &self.accounts,
                    keys,
                    clock_ts(slot, self.clock_ts),
                    if with_rent { self.rent } else { None },
                ),
                keys,
                with_rent,
                min_slot,
            ),
        };
        async move { r }
    }
}

/// A fake `ChainPort` over an account map whose Clock reads `ts` (the
/// gather's window test needs a clock past the reveal close). Counts and
/// refuses any `simulate` or `send`.
struct ClockedPort {
    accounts: BTreeMap<Address, Option<Account>>,
    ts: i64,
    forbidden: AtomicUsize,
    /// The lower bound of every `accounts` read (one entry per wave).
    min_slots: Mutex<Vec<u64>>,
}

impl ClockedPort {
    fn new(accounts: BTreeMap<Address, Option<Account>>, ts: i64) -> ClockedPort {
        ClockedPort {
            accounts,
            ts,
            forbidden: AtomicUsize::new(0),
            min_slots: Mutex::new(vec![]),
        }
    }
}

impl ChainPort for ClockedPort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(ClockSysvar {
            slot: 900,
            unix_timestamp: self.ts,
            ..ClockSysvar::default()
        })
    }
    fn accounts(
        &self,
        keys: &[Address],
        min_slot: u64,
    ) -> impl Future<Output = PortResult<Vec<Option<Account>>>> + Send {
        self.min_slots.lock().unwrap().push(min_slot);
        let out: Vec<Option<Account>> = keys
            .iter()
            .map(|k| self.accounts.get(k).cloned().flatten())
            .collect();
        async move { Ok(out) }
    }
    fn simulate(&self, _tx: &[u8]) -> impl Future<Output = PortResult<SimResult>> + Send {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        async { Err(PortError::Unsupported("simulate is forbidden here")) }
    }
    fn send(&self, _tx: &[u8]) -> impl Future<Output = PortResult<Signature>> + Send {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        async { Err(PortError::Unsupported("send is forbidden here")) }
    }
    async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(vec![])
    }
    async fn feed(&self, _after: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::default(), 0))
    }
}

/// A supplied proof's provenance claims are replaced, whatever the caller
/// said: `signatures_verified` false, the method the store's own.
#[test]
fn a_supplied_proof_never_keeps_the_callers_provenance_claims() {
    let rec = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    let honest = depart_proof(&rec, &scope()).unwrap();
    assert_eq!(honest.provenance.method, METHOD_FEED);
    let mut forged = honest.clone();
    forged.provenance.signatures_verified = true;
    forged.provenance.method = "attacker: verified by nobody";
    let mut store = ProofStore::default();
    assert!(store.supply(forged));
    let e = store.get(host(), SLOT).unwrap();
    assert!(!e.proof.provenance.signatures_verified);
    assert_eq!(e.proof.provenance.method, METHOD_SUPPLIED);
    assert_eq!(e.origin, ORIGIN_SUPPLIED);
    // The feed path keeps the extractor's own provenance.
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&[rec], &scope(), 1), 1);
    let e = store.get(host(), SLOT).unwrap();
    assert_eq!(e.proof.provenance.method, METHOD_FEED);
    assert!(!e.proof.provenance.signatures_verified);
    // The store's status never carries the caller's text.
    assert!(!store.status().to_string().contains("attacker"));
}

/// Extraction follows the observer's **actual** acceptance of each page
/// (`WideObserver::accepted_prefix`), never a sequence threshold: a page
/// the observer refuses before applying anything (out of order) yields no
/// proof even when a valid departure precedes the offending record; an
/// observer already blocked yields none from any later page, whatever the
/// sequences; a record that blocks the observer mid-page keeps the records
/// before it only; an exact replay is accepted again (a no-op in the
/// store); extraction is bounded per page; drops are counted; the
/// observer's cursor and replay behaviour are untouched.
#[test]
fn proof_extraction_follows_the_observers_accepted_prefix_not_a_sequence_threshold() {
    // Chained in the order built (the observer verifies continuity from
    // the first link it sees).
    let mut chains = Chains::default();
    let mut at = |seq: u64| chains.depart_at(seq);
    let observer = || {
        WideObserver::new(
            IndexScope {
                program: program(),
                season: season_pda().0,
                world: world(),
                source: "test".into(),
            },
            Limits::default(),
        )
    };
    // (a) A page out of order: [8, 10, 9]. The observer validates the
    // whole page first and applies nothing; a numeric `seq < 9` would
    // have taken 8. The accepted prefix is 0 and so is the store.
    let mut o = observer();
    let page = vec![at(8), at(10), at(9)];
    assert_eq!(o.observe_page(&page, &program()), 0);
    assert_eq!(o.accepted_prefix, 0);
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(9));
    assert_eq!(o.model.cursor(), None, "no cursor moved");
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&page, &scope(), o.accepted_prefix), 0);
    assert_eq!(
        (
            store.records_seen,
            store.records_offered,
            store.dropped_unaccepted,
            store.len()
        ),
        (3, 0, 3, 0)
    );
    // (b) An observer blocked at 100 shown a later page of lower
    // sequences [50, 51]: nothing, whatever `50 < 100` would say.
    let mut o = observer();
    let mut truncated = at(100);
    truncated.logs.push("Log truncated".into());
    assert_eq!(o.observe_page(&[truncated], &program()), 0);
    assert_eq!((o.accepted_prefix, o.decode_failures), (0, 1));
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(100));
    let later = vec![at(50), at(51)];
    assert_eq!(o.observe_page(&later, &program()), 0);
    assert_eq!(o.accepted_prefix, 0);
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&later, &scope(), o.accepted_prefix), 0);
    assert_eq!((store.records_offered, store.dropped_unaccepted), (0, 2));
    // (c) A valid page [11, 12]: both processed, the later superseding.
    let mut o = observer();
    let page = vec![at(11), at(12)];
    assert_eq!(o.observe_page(&page, &program()), 2);
    assert_eq!(o.accepted_prefix, 2);
    assert_eq!(o.model.cursor(), Some(12));
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&page, &scope(), o.accepted_prefix), 2);
    assert_eq!(
        (store.superseded, store.get(host(), SLOT).unwrap().seq),
        (1, 12)
    );
    // (d) The same page again: an exact replay, no state change, the
    // whole page accepted again; the store offers both and stores
    // nothing new.
    assert_eq!(o.observe_page(&page, &program()), 0);
    assert_eq!((o.accepted_prefix, o.replayed_txs, o.wide_txs), (2, 0, 2));
    assert_eq!(o.model.cursor(), Some(12), "the cursor did not move");
    assert_eq!(store.observe_page(&page, &scope(), o.accepted_prefix), 0);
    assert_eq!((store.records_offered, store.superseded), (4, 1));
    // (e) A record that blocks the observer in the middle of a page
    // [13, 14(truncated), 15]: 13 processed, 14 blocks, 15 never reached.
    let first = at(13);
    let mut bad = at(14);
    bad.logs.push("Log truncated".into());
    let page = vec![first, bad, at(15)];
    assert_eq!(o.observe_page(&page, &program()), 1);
    assert_eq!(o.accepted_prefix, 1);
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(14));
    assert_eq!(o.model.cursor(), Some(13));
    assert_eq!(store.observe_page(&page, &scope(), o.accepted_prefix), 1);
    assert_eq!(
        store.get(host(), SLOT).unwrap().seq,
        13,
        "15 was never offered"
    );
    assert_eq!(store.dropped_unaccepted, 2);
    // Blocked now: a further page yields nothing.
    assert_eq!(o.observe_page(&[at(16)], &program()), 0);
    assert_eq!(o.accepted_prefix, 0);
    assert_eq!(
        store.observe_page(&[at(16)], &scope(), o.accepted_prefix),
        0
    );
    assert_eq!(store.get(host(), SLOT).unwrap().seq, 13);
    // (f) A page from another program: refused whole, nothing accepted.
    let mut o = observer();
    assert_eq!(o.observe_page(&[at(20)], &actor()), 0);
    assert_eq!(o.accepted_prefix, 0);
    // (g) Bounded per page: records past the bound are counted, not
    // offered, even when the observer accepted them all.
    let mut store = ProofStore::default();
    let long: Vec<TxRecord> = (0..MAX_EXTRACT_PER_PAGE as u64 + 2)
        .map(|i| {
            let mut r = record(vec![], vec![]);
            r.seq = 100 + i;
            r
        })
        .collect();
    assert_eq!(store.observe_page(&long, &scope(), long.len()), 0);
    assert_eq!(
        (
            store.records_seen as usize,
            store.records_offered as usize,
            store.dropped_over_bound
        ),
        (MAX_EXTRACT_PER_PAGE + 2, MAX_EXTRACT_PER_PAGE, 2)
    );
    let st = store.status();
    assert_eq!(st["dropped_over_bound"], 2);
    assert_eq!(st["dropped_unaccepted"], 0);
    assert_eq!(st["extract_per_page"], MAX_EXTRACT_PER_PAGE);
    // An `accepted` beyond the page is just the page.
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&[at(30)], &scope(), 99), 1);
}

/// A reveal whose publication is not served is retried at the next slot,
/// at most `MAX_TRANSIENT_RETRIES` times in a row, then waits the reveal
/// refresh; it never inherits the duties' 64-slot cooldown; a newer proof
/// for the same march invalidates the entry at once; the reads' minimum
/// slot is `max(tick slot, proof slot)`.
#[test]
fn reveal_hints_retry_next_slot_bounded_and_a_new_proof_invalidates_the_entry() {
    let model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test".into(),
        },
        Limits::default(),
    );
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let season = Season::decode(&season_ok()).unwrap();
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let rec = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    assert_eq!(review.proofs.observe_page(&[rec], &scope(), 1), 1);
    let mut none = NoPublications { asks: vec![] };
    let step = |review: &mut WideReview, none: &mut NoPublications, slot: u64| {
        block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            slot,
            None,
            Some(RevealInputs {
                season: &season,
                beacon: none,
                beneficiary: actor(),
            }),
        ))
    };
    // The proof's record landed at slot 1,011: a tick at 50 reads at 1,011.
    assert_eq!(step(&mut review, &mut none, 50), 1);
    assert_eq!(review.publications_missing, 1);
    assert!(port.min_slots.lock().unwrap().iter().all(|s| *s == 1_011));
    assert_eq!(review.status()["recent"][0]["min_slot"], 1_011);
    assert_eq!(review.status()["recent"][0]["next"], "next slot");
    // Not within the same slot; at the next slot, yes — and so on, each a
    // transient retry, MAX_TRANSIENT_RETRIES times.
    assert_eq!(step(&mut review, &mut none, 50), 0);
    for i in 1..=MAX_TRANSIENT_RETRIES as u64 {
        assert_eq!(step(&mut review, &mut none, 50 + i), 1, "retry {i}");
    }
    assert_eq!(review.transient_retries, MAX_TRANSIENT_RETRIES as u64);
    assert_eq!(
        review.publications_missing,
        MAX_TRANSIENT_RETRIES as u64 + 1
    );
    // The retries are used: the next slot is not planned; the status says
    // it waits the reveal refresh; it is planned again after it (well
    // before the duties' 64 slots).
    let last = 50 + MAX_TRANSIENT_RETRIES as u64;
    assert_eq!(
        review.status()["recent"][0]["next"],
        "retries used; reveal refresh"
    );
    assert_eq!(step(&mut review, &mut none, last + 1), 0);
    const { assert!(REVEAL_REFRESH_SLOTS < REFRESH_SLOTS) };
    assert_eq!(
        step(&mut review, &mut none, last + REVEAL_REFRESH_SLOTS - 1),
        0
    );
    assert_eq!(step(&mut review, &mut none, last + REVEAL_REFRESH_SLOTS), 1);
    assert_eq!(
        review.status()["recent"][0]["retry"],
        0,
        "the count restarted"
    );
    // A tick past the proof's slot reads at the tick's slot.
    port.min_slots.lock().unwrap().clear();
    let far = 5_000u64;
    assert_eq!(step(&mut review, &mut none, far), 1);
    assert!(port.min_slots.lock().unwrap().iter().all(|s| *s == far));
    // A newer proof for the same march (a later record) invalidates the
    // entry: planned at once, inside any window, and said so.
    let mut later = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    later.seq = 12;
    later.slot = 1_012;
    assert_eq!(review.proofs.observe_page(&[later], &scope(), 1), 1);
    assert_eq!(review.proofs.superseded, 1);
    assert_eq!(
        step(&mut review, &mut none, far),
        1,
        "the new proof is planned at once"
    );
    assert_eq!(review.proofs_renewed, 1);
    let r = &review.status()["recent"][0];
    assert_eq!(r["proof_renewed"], true);
    assert_eq!(r["proof_seq"], 12);
    assert_eq!(r["retry"], 0);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // Every ask was for the computed round at the tick's slot.
    let round = fclient::clock::SeasonClock::from_season(&season).tlock_round(ARRIVE_BELL);
    assert!(none.asks.iter().all(|(r, _)| *r == round));
}

/// Status carries typed codes only: a port's, an RPC's or a library's
/// error text (which may hold a URL with credentials or arbitrary server
/// output) never reaches it.
#[test]
fn status_never_serialises_raw_error_text() {
    let secret = "http://user:hunter2@rpc.example/?token=abc";
    assert_eq!(block_code(&Block::Read(secret.into())), "Read");
    assert_eq!(block_code(&Block::Snapshot("Rpc".into())), "Snapshot(Rpc)");
    assert_eq!(
        block_code(&Block::Snapshot("Stale(900,901)".into())),
        "Snapshot(Stale(900,901))"
    );
    assert_eq!(
        block_code(&Block::Snapshot(format!("Rpc {secret}"))),
        "Snapshot(Other)",
        "a snapshot code with foreign text is not passed through"
    );
    assert_eq!(block_code(&Block::SealOpen(secret.into())), "SealOpen");
    assert_eq!(
        block_code(&Block::BadPlaintext(secret.into())),
        "BadPlaintext"
    );
    assert_eq!(
        block_code(&Block::MarchValues(secret.into())),
        "MarchValues"
    );
    assert_eq!(block_code(&Block::NoMarch), "NoMarch");
    assert_eq!(block_code(&Block::Absent("season")), "Absent(\"season\")");
    assert_eq!(
        SnapshotError::Rpc(secret.into()).code(),
        "Rpc",
        "the snapshot error's own code drops the RPC text"
    );
    // Through the tick: a snapshot source whose RPC fails with that text.
    let model = {
        let mut m = WideDiscovery::new(
            IndexScope {
                program: program(),
                season: season_pda().0,
                world: world(),
                source: "test".into(),
            },
            Limits::default(),
        );
        m.apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
        m
    };
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut failing = LiteralSnapshots::new(fx.reads().accounts);
    failing.error = Some(SnapshotError::Rpc(secret.into()));
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&failing),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!((review.blocked, review.snapshot_blocked), (1, 1));
    let st = review.status();
    assert_eq!(st["recent"][0]["block"], "Snapshot(Rpc)");
    let text = st.to_string();
    assert!(!text.contains("hunter2") && !text.contains("rpc.example") && !text.contains("token="));
    // A failing read port likewise.
    let mut review2 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(
        block_on(review2.step(
            &FailingPort,
            &engine,
            &model,
            program(),
            season_pda().0,
            9,
            None,
            None
        )),
        1
    );
    let st2 = review2.status();
    assert_eq!(st2["recent"][0]["block"], "Read");
    assert!(!st2.to_string().contains("fixture RPC"));
    assert_eq!(engine.pending_len(), 0);
}

/// The all-zero address is the System Program: never a payer whose balance
/// is funding. Unset, the candidates name it as a placeholder and funding
/// is unknown; it cannot be set as the payer; a set public payer is
/// requested in the snapshot and bounded.
#[test]
fn the_placeholder_payer_is_never_funding_and_cannot_be_set() {
    let model = {
        let mut m = WideDiscovery::new(
            IndexScope {
                program: program(),
                season: season_pda().0,
                world: world(),
                source: "test".into(),
            },
            Limits::default(),
        );
        m.apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
        m
    };
    let fx = SettleFx::new(home());
    let mut accounts = fx.reads().accounts;
    // The System Program account, as a node would serve it: executable,
    // with lamports. Its balance must never count.
    accounts.insert(
        Address::default(),
        Some(Account {
            lamports: 1_000_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: true,
        }),
    );
    let port = FakePort {
        accounts: accounts.clone(),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let lit = LiteralSnapshots::new(accounts);
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(review.review_payer(), None);
    assert!(review.set_review_payer(Address::default()).is_err());
    assert_eq!(review.review_payer(), None);
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    let st = review.status();
    assert_eq!(st["payer"], PAYER_UNSET);
    let r = &st["recent"][0];
    assert_eq!(r["candidate"]["coherent"], true);
    let denials = r["assessment"]["review"]["denials"].as_array().unwrap();
    assert!(denials.iter().any(|d| d == "FundingUnknown"));
    assert!(!denials.iter().any(|d| d == "FundingUnmet"));
    assert!(r["assessment"]["needs"]["funding"]
        .as_str()
        .unwrap()
        .contains("not a wallet"));
    // Directly: the fee review over the candidate's own reads says so,
    // whatever the placeholder's account holds.
    let c = fx.plan().unwrap();
    assert_eq!(c.payer, payer());
    let keys: Vec<Address> = fx.reads().accounts.keys().copied().collect();
    let snap = snapshot_of(&fx.reads().accounts, &keys, clock_at(1_790_444_847), 7);
    let c0 = done(wideduty::plan_settle_departure(
        &dscope(),
        Address::default(),
        host(),
        SLOT,
        &snap.reads(),
    ))
    .unwrap();
    assert!(c0.coherent());
    let n = widefees::duty_needs(&c0, &snap.reads()).unwrap();
    assert_eq!(n.funding, Funding::Unknown(keeper_core::widefees::NO_PAYER));
    assert_eq!(
        n.rent_lamports,
        Known::Known(0),
        "the rent is still calculated"
    );
    // A set public payer is requested and bounded.
    let mut review2 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert!(review2.set_review_payer(actor()).is_ok());
    assert_eq!(review2.review_payer(), Some(actor()));
    let made = block_on(review2.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert!(lit.keys.lock().unwrap().last().unwrap().contains(&actor()));
    let st2 = review2.status();
    assert_eq!(st2["payer"], actor().to_string());
    let d2 = st2["recent"][0]["assessment"]["review"]["denials"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        d2.iter().any(|d| d == "FundingUnmet"),
        "the set payer's account is absent in the response: unmet, not unknown"
    );
    assert!(!st2["missing"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m.as_str().unwrap().starts_with("payer")));
    assert_eq!(engine.pending_len(), 0);
}

/// The keeper's own read port as the snapshot source: the function pointer
/// taken where `P: SnapshotPort` is known, called where only `ChainPort`
/// is; one request, the response bound as any other.
#[test]
fn the_keepers_own_port_serves_the_snapshot_through_the_function_pointer() {
    let model = {
        let mut m = WideDiscovery::new(
            IndexScope {
                program: program(),
                season: season_pda().0,
                world: world(),
                source: "test".into(),
            },
            Limits::default(),
        );
        m.apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
        m
    };
    let fx = SettleFx::new(home());
    let port = FakePort {
        accounts: fx.reads().accounts,
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let lit = LiteralSnapshots::new(fx.reads().accounts);
    let via = PortSnapshot {
        port: &lit,
        f: snapshot_via::<LiteralSnapshots>,
    };
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&via),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!(lit.calls.load(Ordering::SeqCst), 1);
    assert_eq!((review.coherent, review.snapshot_blocked), (1, 0));
    let st = review.status();
    assert_eq!(st["recent"][0]["candidate"]["coherent"], true);
    assert_eq!(st["recent"][0]["snapshot"]["context_slot"], 900);
    assert_eq!(engine.pending_len(), 0);
}

// ------------------------------------------------------------ handler parity pins

/// The planner's Season judgement is exactly the ABI rule the handlers
/// apply (`settle_season` → `read_season` → `effective_status`, then the
/// allowed list `[Running, Ended]`): for every stored status and a clock
/// before, at and after genesis, the planner plans iff the effective
/// status is allowed, says "promoted" iff the promotion did it, and names
/// the handler's refusal otherwise.
#[test]
fn season_judgement_matches_the_abi_effective_status_rule() {
    let allowed = [SL::STATUS_RUNNING, SL::STATUS_ENDED];
    for stored in [
        SL::STATUS_ANNOUNCED,
        SL::STATUS_CREATED,
        SL::STATUS_SEEDED,
        SL::STATUS_RUNNING,
        SL::STATUS_ENDED,
        SL::STATUS_CLOSED,
        SL::STATUS_ABORTED,
    ] {
        for now in [GENESIS_TS - 1, GENESIS_TS, GENESIS_TS + 1] {
            let effective = SL::effective_status(stored, GENESIS_TS, now);
            let mut fx = SettleFx::new(home());
            fx.season = season_bytes(stored, WIDE_VERSION);
            let mut reads = fx.reads();
            reads.clock = Some(clock_at(now));
            let r = done(wideduty::plan_settle_departure(
                &dscope(),
                payer(),
                host(),
                SLOT,
                &reads,
            ));
            if allowed.contains(&effective) {
                let c = r.unwrap_or_else(|b| panic!("stored {stored} at {now}: {b:?}"));
                assert_eq!(
                    c.status_promoted_by_clock,
                    stored == SL::STATUS_SEEDED,
                    "stored {stored} at {now}"
                );
            } else if stored == SL::STATUS_SEEDED {
                assert_eq!(
                    r,
                    Err(Block::SeasonNotStarted {
                        genesis_ts: GENESIS_TS,
                        observed: now
                    }),
                    "stored {stored} at {now}"
                );
            } else {
                assert_eq!(
                    r,
                    Err(Block::SeasonStatus(stored)),
                    "stored {stored} at {now}"
                );
            }
        }
    }
    // The same rule the handler's `effective_status` states: only Seeded
    // moves, and only at or after genesis.
    assert_eq!(
        SL::effective_status(SL::STATUS_SEEDED, GENESIS_TS, GENESIS_TS),
        SL::STATUS_RUNNING
    );
    assert_eq!(
        SL::effective_status(SL::STATUS_SEEDED, GENESIS_TS, GENESIS_TS - 1),
        SL::STATUS_SEEDED
    );
    assert_eq!(
        SL::effective_status(SL::STATUS_CREATED, GENESIS_TS, i64::MAX),
        SL::STATUS_CREATED
    );
}

/// The planner's notion of an absent account is the program's (`addr::absent`,
/// §4.1: System-owned **and** no data; lamports ignored). Every other shape
/// at a canonical position is a refusal on both sides — `BadAccount` there,
/// a typed block here — never a plan.
#[test]
fn absence_rule_matches_the_programs_definition_at_every_position() {
    let system = fclient::addr::system_program();
    assert!(is_absent(&system, &[]));
    assert!(!is_absent(&system, &[0]), "data makes it present");
    assert!(
        !is_absent(&program(), &[]),
        "a program-owned empty account is present"
    );
    assert!(!is_absent(&actor(), &[]));
    let acc = |owner: Address, data: Vec<u8>, lamports: u64| {
        Some(Account {
            lamports,
            data,
            owner,
            executable: false,
        })
    };
    let fx = SettleFx::new(home());
    let plan = |reads: &Reads| {
        done(wideduty::plan_settle_departure(
            &dscope(),
            payer(),
            host(),
            SLOT,
            reads,
        ))
    };
    // System-owned, no data, lamports: absent (the handler's `BadAccount`
    // for a missing holding; the planner's typed `Absent`).
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.holding_addr(), acc(system, vec![], 5_000_000));
    assert_eq!(plan(&reads), Err(Block::Absent("holding")));
    // System-owned with data: present but foreign (`BadAccount` there).
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.holding_addr(), acc(system, vec![1], 1));
    assert_eq!(plan(&reads), Err(Block::ForeignOwner("holding")));
    // Program-owned, no data: present and unreadable (`BadAccount` there).
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.holding_addr(), acc(program(), vec![], 1));
    assert_eq!(plan(&reads), Err(Block::Unreadable("holding")));
    // The same three shapes at the transit position: absent is "no march"
    // (`TransitState` there), the others refusals.
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.transit_addr(), acc(system, vec![], 1));
    assert_eq!(plan(&reads), Err(Block::NoMarch));
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.transit_addr(), acc(actor(), vec![0; 288], 1));
    assert_eq!(plan(&reads), Err(Block::ForeignOwner("transit")));
    let mut reads = fx.reads();
    reads
        .accounts
        .insert(fx.transit_addr(), acc(program(), vec![], 1));
    assert_eq!(plan(&reads), Err(Block::Unreadable("transit")));
    // A key the planner asked for and did not get is a read failure, never
    // treated as absent.
    let mut reads = fx.reads();
    reads.accounts.remove(&fx.transit_addr());
    assert!(matches!(
        wideduty::plan_settle_departure(&dscope(), payer(), host(), SLOT, &reads),
        Step::Need(ref a) if a == &vec![fx.transit_addr()]
    ));
}

/// The handler's `open_transits_of` returns every **present** record of the
/// holding's four slots, in any state — `Departed`, `Settled`, even `Free`
/// after the transit settled but before its close — and a Leave entry whose
/// host appears in one is skipped (`HostInTransit` when nothing else
/// returns). The planner mirrors that exactly; it does not relax the rule
/// to in-transit states.
#[test]
fn a_present_transit_record_in_any_state_holds_the_return_back_as_the_handler_does() {
    let departed = transit_bytes(host(), home(), false, root());
    let settled = transit_bytes(host(), home(), true, root());
    let free = {
        let t = WideTransit::from_bytes(&settled).unwrap();
        let f = t.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f.state, MarchState::Free);
        assert!(!f.state.in_transit());
        f.to_bytes().to_vec()
    };
    for (label, bytes) in [("departed", departed), ("settled", settled), ("free", free)] {
        for slot in 0..4 {
            let mut fx = ReturnFx::new(home(), &[host()]);
            fx.transits[slot] = Some(bytes.clone());
            assert_eq!(
                fx.plan(),
                Err(Block::HostInTransit),
                "{label} in slot {slot}"
            );
        }
        // Another host's record of any state does not hold this one back.
        let other = WideHostRef::new(home(), SITE, GEN, 99).unwrap();
        let mut fx = ReturnFx::new(home(), &[host()]);
        let mut t = WideTransit::from_bytes(&bytes).unwrap();
        t.host = other;
        fx.transits[1] = Some(t.to_bytes().to_vec());
        let c = fx.plan().unwrap_or_else(|b| panic!("{label}: {b:?}"));
        assert_eq!(return_facts(&c).skipped_in_transit, 0, "{label}");
        assert_eq!(return_facts(&c).picks.len(), 1, "{label}");
    }
    // No record at all: the host returns.
    let fx = ReturnFx::new(home(), &[host()]);
    let c = fx.plan().unwrap();
    assert_eq!(return_facts(&c).picks[0].host, host());
}

/// The proof store keeps a proof **past its reveal** for the transit
/// settlement: `settle_hints` lists a revealed open march (the reveal
/// hints no longer do), not an unrevealed one, and not one whose record
/// was closed.
#[test]
fn the_proof_store_lists_revealed_open_marches_for_settlement() {
    let mut store = ProofStore::default();
    let rec = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    assert_eq!(store.observe_page(&[rec], &scope(), 1), 1);
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
    assert!(
        store.settle_hints(&model).is_empty(),
        "not revealed: a reveal hint, not a settle one"
    );
    assert_eq!(store.hints(&model), vec![(host(), SLOT)]);
    model
        .apply(&WideBatch {
            seq: 2,
            slot: 1_002,
            signature: "sig-2".into(),
            bodies: vec![encode(
                WideKind::Revealed,
                ARRIVE_BELL,
                &wev::host_key(&host(), away()),
                &wev::revealed_payload(SLOT, 0, 0, 33, 0, 0, TROOPS, false),
                &[],
            )
            .unwrap()],
        })
        .unwrap();
    assert_eq!(
        store.settle_hints(&model),
        vec![(host(), SLOT)],
        "revealed: kept for the settlement"
    );
    assert!(store.hints(&model).is_empty());
    assert_eq!(store.len(), 1, "the proof is retained after the reveal");
    model
        .apply(&WideBatch {
            seq: 3,
            slot: 1_003,
            signature: "sig-3".into(),
            bodies: vec![encode(
                WideKind::TransitClosed,
                ARRIVE_BELL + 5,
                &wev::host_key(&host(), away()),
                &wev::transit_closed_payload(SLOT, &[0xd4; 32], 1),
                &[],
            )
            .unwrap()],
        })
        .unwrap();
    assert!(
        store.settle_hints(&model).is_empty(),
        "closed: nothing to settle"
    );
}

/// `proofs_for` keeps a proof while its march is open and unrevealed,
/// **including after the departure settled at the origin** (the handler's
/// Reveal accepts every in-transit state); it drops it once the march is
/// revealed or settled, and never names a slot the model does not show
/// departed. `ProofStore::hints` agrees at every step.
#[test]
fn proofs_for_keeps_a_settled_departure_until_revealed_or_settled() {
    let rec = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    let proof = depart_proof(&rec, &scope()).unwrap();
    let proofs = [proof.clone()];
    let mut store = ProofStore::default();
    assert_eq!(store.observe_page(&[rec], &scope(), 1), 1);
    let model = |bodies: Vec<Vec<Vec<u8>>>| {
        let mut m = WideDiscovery::new(
            IndexScope {
                program: program(),
                season: season_pda().0,
                world: world(),
                source: "test".into(),
            },
            Limits::default(),
        );
        for (i, b) in bodies.into_iter().enumerate() {
            m.apply(&WideBatch {
                seq: 1 + i as u64,
                slot: 1_001 + i as u64,
                signature: format!("sig-{i}"),
                bodies: b,
            })
            .unwrap();
        }
        m
    };
    let departed = departed_ok(home());
    let settled_at_origin = both(
        WideKind::DepartureSettled,
        DEPART_BELL + 1,
        &wev::host_key(&host(), home()),
        &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
    );
    let revealed = encode(
        WideKind::Revealed,
        ARRIVE_BELL,
        &wev::host_key(&host(), home()),
        &wev::revealed_payload(SLOT, 0, 0, 33, 0, 0, TROOPS, false),
        &[],
    )
    .unwrap();
    let transit_settled = both(
        WideKind::TransitSettled,
        ARRIVE_BELL + 3,
        &wev::host_key(&host(), home()),
        &wev::transit_settled_payload(SLOT, 1, 0, TROOPS, TIP, 7_000, 11_000, false, home()),
    );
    // Nothing departed: no hint (the model does not show the march).
    let m = model(vec![]);
    assert!(proofs_for(&m, &proofs).is_empty());
    assert_eq!(
        store.hints(&m),
        vec![(host(), SLOT)],
        "the store trusts the chain when the model knows nothing"
    );
    // Departed: the proof is a reveal hint and a settle hint.
    let m = model(vec![vec![departed.clone()]]);
    assert_eq!(proofs_for(&m, &proofs), proofs.to_vec());
    assert_eq!(wideduty::settle_candidates(&m), vec![(host(), SLOT)]);
    assert_eq!(store.hints(&m), vec![(host(), SLOT)]);
    // Departure settled at the origin: no longer a settle hint, **still**
    // a reveal hint (the regression: `settle_candidates` would drop it).
    let m = model(vec![
        vec![departed.clone()],
        vec![settled_at_origin.clone()],
    ]);
    assert!(wideduty::settle_candidates(&m).is_empty());
    assert_eq!(proofs_for(&m, &proofs), proofs.to_vec());
    assert_eq!(store.hints(&m), vec![(host(), SLOT)]);
    // Revealed: gone from both.
    let m = model(vec![
        vec![departed.clone()],
        vec![settled_at_origin.clone()],
        vec![revealed],
    ]);
    assert!(proofs_for(&m, &proofs).is_empty());
    assert!(store.hints(&m).is_empty());
    // Transit settled (the march over): gone from both.
    let m = model(vec![
        vec![departed.clone()],
        vec![settled_at_origin],
        vec![transit_settled],
    ]);
    assert!(proofs_for(&m, &proofs).is_empty());
    assert!(store.hints(&m).is_empty());
    // A proof of another slot than the model's open march: not a hint.
    let mut other_slot = proof;
    other_slot.transit_slot = SLOT + 1;
    let m = model(vec![vec![departed]]);
    assert!(proofs_for(&m, &[other_slot]).is_empty());
}

/// The fee review reports funding only for a payer that can pay: an
/// ordinary System wallet that is not another account of the instruction.
/// A program-owned or executable account, a System account with data (a
/// nonce) is unknown until runtime/nonce checks; program accounts and the
/// Season alias are ineligible. None is reported as funded from balance alone.
#[test]
fn funding_is_reported_only_for_an_eligible_ordinary_wallet() {
    let fx = SettleFx::new(home());
    let clock = clock_at(1_790_444_847);
    let plan_over = |payer: Address, payer_account: Option<Account>| {
        let mut accounts = fx.reads().accounts;
        let mut keys: Vec<Address> = accounts.keys().copied().collect();
        if !keys.contains(&payer) {
            keys.push(payer);
        }
        if let Some(a) = payer_account {
            accounts.insert(payer, Some(a));
        }
        let snap = snapshot_of(&accounts, &keys, clock, 7);
        let reads = snap.reads();
        let c = done(wideduty::plan_settle_departure(
            &dscope(),
            payer,
            host(),
            SLOT,
            &reads,
        ))
        .unwrap();
        assert!(c.coherent());
        let needs = widefees::duty_needs(&c, &reads).unwrap();
        let open = EngineView {
            feed_writes_allowed: true,
            kind_allowed: true,
            already_pending: false,
            care_unresolved: false,
        };
        let a = widereview::review_candidate(&c, &reads, &open);
        assert!(!a.review.admitted);
        (needs, a.review.denials)
    };
    let wallet = |lamports: u64, owner: Address, data: Vec<u8>, executable: bool| Account {
        lamports,
        data,
        owner,
        executable,
    };
    let system = fclient::addr::system_program();
    // An ordinary funded wallet: met (the base fee only; a settle creates
    // nothing).
    let (n, d) = plan_over(actor(), Some(wallet(1_000_000, system, vec![], false)));
    assert_eq!(
        n.funding,
        Funding::MetLowerBound {
            payer_lamports: 1_000_000,
            required: 5_000
        }
    );
    assert!(!d.contains(&Deny::FundingIneligible) && !d.contains(&Deny::FundingUnknown));
    // An ordinary wallet that holds nothing yet (absent): unmet, not
    // ineligible.
    let (n, d) = plan_over(actor(), None);
    assert!(matches!(
        n.funding,
        Funding::Unmet {
            payer_lamports: 0,
            ..
        }
    ));
    assert!(d.contains(&Deny::FundingUnmet));
    // A program-owned executable account with a large balance: ineligible,
    // the balance never reported.
    let (n, d) = plan_over(
        actor(),
        Some(wallet(1_000_000_000, program(), vec![1, 2, 3], true)),
    );
    assert_eq!(
        n.funding,
        Funding::Ineligible(keeper_core::widefees::PAYER_EXECUTABLE)
    );
    assert!(d.contains(&Deny::FundingIneligible));
    assert!(!d.contains(&Deny::FundingUnmet) && !d.contains(&Deny::FundingUnknown));
    assert!(!n.describe().to_string().contains("1000000000"));
    // A program-owned, non-executable account (a record).
    let (n, _) = plan_over(
        actor(),
        Some(wallet(1_000_000_000, program(), vec![0; 64], false)),
    );
    assert_eq!(
        n.funding,
        Funding::Ineligible(keeper_core::widefees::PAYER_PROGRAM_OWNED)
    );
    // A System-owned account with data (a nonce): not an ordinary wallet.
    let (n, d) = plan_over(
        actor(),
        Some(wallet(1_000_000_000, system, vec![0; 80], false)),
    );
    assert_eq!(
        n.funding,
        Funding::Unknown(keeper_core::widefees::PAYER_SYSTEM_DATA)
    );
    assert!(d.contains(&Deny::FundingUnknown));
    assert!(!d.contains(&Deny::FundingIneligible));
    // The Season named as payer: an alias of another account of the
    // instruction (writable payer, read-only Season: an invalid
    // transaction), refused from the candidate alone, whatever the
    // Season account holds.
    let (n, d) = plan_over(season_pda().0, None);
    assert_eq!(
        n.funding,
        Funding::Ineligible(keeper_core::widefees::PAYER_ALIASES)
    );
    assert!(d.contains(&Deny::FundingIneligible));
    // Any other account of the instruction named as payer likewise.
    let (n, _) = plan_over(fx.holding_addr(), None);
    assert_eq!(
        n.funding,
        Funding::Ineligible(keeper_core::widefees::PAYER_ALIASES)
    );
    // The alias is judged without a snapshot too (diagnostic, not
    // funding): over ordinary reads the reason is still the alias.
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        season_pda().0,
        host(),
        SLOT,
        &fx.reads(),
    ))
    .unwrap();
    let n = widefees::duty_needs(&c, &fx.reads()).unwrap();
    assert_eq!(
        n.funding,
        Funding::Ineligible(keeper_core::widefees::PAYER_ALIASES)
    );
}

// ------------------------------------------------------------ the follower

/// A feed port over literal records: `feed(after)` returns the records
/// past `after` in sequence order, at most `page` per call; the cursors
/// asked are recorded; `fail` makes every call an error carrying a
/// secret-looking text; simulate/send are counted as forbidden.
struct FeedPort {
    records: Mutex<Vec<TxRecord>>,
    page: usize,
    asked: Mutex<Vec<u64>>,
    fail: AtomicBool,
    forbidden: AtomicUsize,
}
impl FeedPort {
    fn new(records: Vec<TxRecord>, page: usize) -> FeedPort {
        FeedPort {
            records: Mutex::new(records),
            page,
            asked: Mutex::new(vec![]),
            fail: AtomicBool::new(false),
            forbidden: AtomicUsize::new(0),
        }
    }
}
impl ChainPort for FeedPort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(clock_at(GENESIS_TS))
    }
    async fn accounts(&self, keys: &[Address], _min_slot: u64) -> PortResult<Vec<Option<Account>>> {
        Ok(vec![None; keys.len()])
    }
    async fn simulate(&self, _tx: &[u8]) -> PortResult<SimResult> {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        Err(PortError::Unsupported("simulate is forbidden here"))
    }
    async fn send(&self, _tx: &[u8]) -> PortResult<Signature> {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        Err(PortError::Unsupported("send is forbidden here"))
    }
    async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(vec![])
    }
    fn feed(&self, after: Cursor) -> impl Future<Output = PortResult<Vec<TxRecord>>> + Send {
        self.asked.lock().unwrap().push(after.0);
        let r = if self.fail.load(Ordering::SeqCst) {
            Err(PortError::Io(
                "http://user:hunter2@feed.example/?token=abc refused".into(),
            ))
        } else {
            Ok(self
                .records
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.seq > after.0)
                .take(self.page)
                .cloned()
                .collect())
        };
        async move { r }
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::default(), 0))
    }
}

fn follow_observer() -> WideObserver {
    WideObserver::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: the follower".into(),
        },
        Limits::default(),
    )
}

/// Event chains as the program emits them and the typed index verifies
/// them: per `(entity, full key)` the last `(seq, head)`, each new record's
/// links computed with the ABI's `advance` over its body without tail
/// (SHA-256 only; nothing signed).
#[derive(Default)]
struct Chains(BTreeMap<(u8, Vec<u8>), (u64, [u8; 32])>);
impl Chains {
    fn body(&mut self, kind: WideKind, bell: u32, keybytes: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; wev::MAX_BODY];
        let n = wev::write_body(kind, bell, keybytes, payload, &mut b).unwrap();
        b.truncate(n);
        // A zero-link-shaped encoding gives the record's canonical
        // attribution (province, holding) to key the chains by.
        let shape: Vec<WideLink> = kind
            .links()
            .iter()
            .map(|e| WideLink {
                entity: *e,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        let probe = encode(kind, bell, keybytes, payload, &shape).unwrap();
        let r = wev::WideRecord::decode(&probe).unwrap();
        let links: Vec<WideLink> = kind
            .links()
            .iter()
            .map(|e| {
                let identity = match e {
                    WideEntity::Province => r.province_of().unwrap().to_bytes().to_vec(),
                    WideEntity::Holding => r.holding_of().unwrap().to_bytes().to_vec(),
                };
                let old = self.0.entry((*e as u8, identity)).or_insert((0, [0; 32]));
                let next = wev::advance(*e, old.0, &old.1, &b).unwrap();
                *old = (next.seq, next.head);
                next
            })
            .collect();
        encode(kind, bell, keybytes, payload, &links).unwrap()
    }
    /// The `Departed` body of `host()` standing at home, the fixture's
    /// values (the ones `departed_ok` carries), properly chained.
    fn departed(&mut self) -> Vec<u8> {
        self.body(
            WideKind::Departed,
            DEPART_BELL,
            &wev::host_key(&host(), home()),
            &wev::departed_payload(
                SLOT,
                DEPART_BELL,
                ARRIVE_BELL,
                TROOPS,
                61,
                TIP,
                7_000,
                11_000,
                &root(),
            ),
        )
    }
    /// A committed WideDepart transaction at `seq` (slot `1_000 + seq`, a
    /// signature unique to the sequence): the wire's Depart and its
    /// frame's chained `Departed` record.
    fn depart_at(&mut self, seq: u64) -> TxRecord {
        let body = self.departed();
        self.depart_record_with(seq, body)
    }
    fn depart_record_with(&mut self, seq: u64, body: Vec<u8>) -> TxRecord {
        let mut r = record(wire_of(&[depart_ix(home())]), frame(&[body]));
        r.seq = seq;
        r.slot = 1_000 + seq;
        sign_as(&mut r, seq);
        r
    }
}

/// A signature unique to `seq`, on the record **and** as the wire's first
/// signature (the extractor binds the two; the typed index wants
/// signatures unique). Literal bytes, nothing signed.
fn sign_as(r: &mut TxRecord, seq: u64) {
    let mut sig = SIG_PAYER;
    sig[..8].copy_from_slice(&seq.to_le_bytes());
    r.signature = Signature::from(sig);
    if r.tx.len() >= 65 {
        // One-byte signature count, then the signatures.
        r.tx[1..65].copy_from_slice(&sig);
    }
}

/// The follower pulls bounded pages from its own cursor only in ticks the
/// legacy path did not pull, shows them to the observer and the proof
/// store exactly as the legacy pull does, advances its cursor to the last
/// record the observer accepted, and reports a caught-up empty page; the
/// public knob cannot raise the cap; simulate/send are never called.
#[test]
fn the_follower_pulls_bounded_pages_after_the_gate_and_feeds_observer_and_proofs() {
    let mut c = Chains::default();
    let port = FeedPort::new((11..=16).map(|s| c.depart_at(s)).collect(), 2);
    let mut o = follow_observer();
    let mut store = ProofStore::default();
    assert_eq!(
        WideFollow::from_observer(&o).cursor().0,
        0,
        "an empty observer: from the start"
    );
    // The literal feed begins at 11: resume after 10 (contiguity is a rule).
    let mut f = WideFollow::new(Some(10));
    f.pages_per_tick = 99;
    assert_eq!(
        f.cap(),
        FOLLOW_PAGES_PER_TICK,
        "the public knob cannot raise the cap"
    );
    // The legacy path pulled this tick: the follower stands aside.
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), true)),
        0
    );
    assert_eq!((f.ticks, f.idle_shared_feed), (1, 1));
    assert!(
        port.asked.lock().unwrap().is_empty(),
        "the shared feed was not pulled twice"
    );
    // The gate blocked (no legacy pull): two pages of two, the observer and
    // the store see four records, the cursor stands at 14.
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        2
    );
    assert_eq!(*port.asked.lock().unwrap(), vec![10, 12]);
    assert_eq!(
        (f.pages, f.records, f.cursor().0, f.last_slot),
        (2, 4, 14, Some(1_014))
    );
    assert_eq!(
        (o.chain_anchored_from_genesis, o.chain_anchored_unverified, o.chain_verified),
        (2, 0, 6),
        "the first record's links were the first from the zero head: verified from genesis; three more verified both"
    );
    assert!(o.chain(WideTarget::Province(home())).unwrap().from_genesis);
    assert_eq!(o.last_seq_seen, Some(14));
    assert_eq!(o.wide_txs, 4);
    assert_eq!(o.model.cursor(), Some(14));
    assert_eq!(
        (store.from_feed, store.get(host(), SLOT).unwrap().seq),
        (4, 14)
    );
    assert!(!f.caught_up);
    // Next tick: the last page, then the empty page — caught up.
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        2
    );
    assert_eq!(*port.asked.lock().unwrap(), vec![10, 12, 14, 16]);
    assert_eq!((f.pages, f.records, f.cursor().0), (4, 6, 16));
    assert!(f.caught_up);
    assert_eq!(o.last_seq_seen, Some(16));
    assert_eq!(store.get(host(), SLOT).unwrap().seq, 16);
    // `caught_up` is the last step's, not a standing claim: an idle tick
    // clears it.
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), true)),
        0
    );
    assert!(!f.caught_up, "an idle tick says nothing about currency");
    // Without a proof store the observer still sees the pages.
    let port2 = FeedPort::new(vec![c.depart_at(17)], 2);
    assert_eq!(block_on(f.step(&port2, &mut o, None, &scope(), false)), 2);
    assert!(f.caught_up, "this step ended on an empty page");
    assert_eq!(o.last_seq_seen, Some(17));
    assert_eq!(
        store.get(host(), SLOT).unwrap().seq,
        16,
        "no store, no extraction"
    );
    assert_eq!(
        port.forbidden.load(Ordering::SeqCst) + port2.forbidden.load(Ordering::SeqCst),
        0
    );
    let st = f.status();
    assert_eq!(st["automatic_writes"], false);
    assert_eq!(st["source_complete"], false);
    assert_eq!(st["history_authenticated"], false);
    assert_eq!(st["legacy_cursors_touched"], false);
    assert_eq!(st["hard_cap"], FOLLOW_PAGES_PER_TICK);
    assert_eq!(st["pages_per_tick"], FOLLOW_PAGES_PER_TICK);
    assert_eq!(st["cursor"], 17);
    assert!(st["stopped"].is_null());
    // The observer's own statement is unchanged by any of it.
    assert_eq!(o.status()["source_complete"], false);
    assert_eq!(o.status()["automatic_writes"], false);
}

/// The follower resumes after what the observer processed, and before a
/// pull it catches up to the observer when the legacy path moved it
/// further: a page the observer already saw is never pulled again.
#[test]
fn the_follower_resumes_after_the_observers_position_and_never_repulls_it() {
    let mut o = follow_observer();
    // One chained history, 11..=17, served in parts by both paths.
    let mut c = Chains::default();
    let recs: Vec<TxRecord> = (11..=17).map(|s| c.depart_at(s)).collect();
    // The legacy path showed the observer seqs 11 and 12.
    assert_eq!(o.observe_page(&recs[0..2], &program()), 2);
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(f.cursor().0, 12);
    let port = FeedPort::new(recs[0..4].to_vec(), 10);
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 2);
    assert_eq!(
        *port.asked.lock().unwrap(),
        vec![12, 14],
        "after 12, then the empty page"
    );
    assert_eq!(o.wide_txs, 4);
    assert_eq!(
        (
            o.chain_anchored_from_genesis,
            o.chain_anchored_unverified,
            o.chain_verified
        ),
        (2, 0, 6),
        "the chains continued across the two paths"
    );
    // The legacy path pulled 15 and 16 while the follower stood aside; the
    // follower catches up before its next pull.
    assert_eq!(o.observe_page(&recs[4..6], &program()), 2);
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), true)), 0);
    assert_eq!(f.cursor().0, 14);
    let port = FeedPort::new(recs.clone(), 10);
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 2);
    assert_eq!(*port.asked.lock().unwrap(), vec![16, 17]);
    assert_eq!((f.caught_up_to_observer, f.cursor().0), (1, 17));
    assert_eq!(o.last_seq_seen, Some(17));
    assert_eq!(f.status()["caught_up_to_observer"], 1);
}

/// When the observer blocks — at a record of a page, or before the page —
/// the follower stops fail-closed: its cursor at the last accepted record,
/// the proof store given the accepted prefix only, no further pull in any
/// later tick, the typed stop in the status. Nothing bypasses the
/// observer's refusal.
#[test]
fn the_follower_stops_when_the_observer_blocks_and_never_pulls_past_it() {
    let mut c = Chains::default();
    let first = c.depart_at(17);
    let mut bad = c.depart_at(18);
    bad.logs.push("Log truncated".into());
    let port = FeedPort::new(vec![first, bad, c.depart_at(19), c.depart_at(20)], 3);
    let mut o = follow_observer();
    let mut store = ProofStore::default();
    let mut f = WideFollow::new(Some(16));
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        1
    );
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(18));
    assert_eq!(
        (o.accepted_prefix, o.wide_txs, o.decode_failures),
        (1, 1, 1)
    );
    assert_eq!(f.cursor().0, 17, "the last record the observer accepted");
    assert_eq!(f.last_slot, Some(1_017));
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 18))
    );
    assert_eq!(store.get(host(), SLOT).unwrap().seq, 17);
    assert_eq!(store.dropped_unaccepted, 2, "18 and 19 were never offered");
    // Later ticks: no pull at all, stopped stays.
    for _ in 0..3 {
        assert_eq!(
            block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
            0
        );
    }
    assert_eq!(*port.asked.lock().unwrap(), vec![16]);
    assert_eq!(f.cursor().0, 17);
    assert_eq!(f.stopped().map(|s| s.code), Some(STOP_OBSERVER_BLOCKED));
    let st = f.status();
    assert_eq!(st["stopped"]["code"], STOP_OBSERVER_BLOCKED);
    assert_eq!(st["stopped"]["seq"], 18);
    assert!(
        !st.to_string().contains("Truncated"),
        "the observer's reason text is the observer's"
    );
    // An observer blocked before the follower's first pull: stopped at
    // once, nothing pulled.
    let mut o2 = follow_observer();
    let mut c2 = Chains::default();
    let mut t = c2.depart_at(5);
    t.logs.push("Log truncated".into());
    assert_eq!(o2.observe_page(&[t], &program()), 0);
    let mut f2 = WideFollow::from_observer(&o2);
    let port2 = FeedPort::new(vec![c2.depart_at(6)], 2);
    assert_eq!(block_on(f2.step(&port2, &mut o2, None, &scope(), false)), 0);
    assert!(port2.asked.lock().unwrap().is_empty());
    assert_eq!(
        f2.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 5))
    );
}

/// A page that is not past the cursor or not strictly increasing is the
/// follower's own fail-closed stop: the observer is not shown it, the
/// cursor does not move, nothing is pulled later.
#[test]
fn the_follower_refuses_a_page_that_is_not_past_its_cursor_before_the_observer_sees_it() {
    // Overlap: a record at the cursor (the literal fake serves exactly
    // what it is given, overlap included).
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(12));
    struct Overlap(Vec<TxRecord>);
    impl ChainPort for Overlap {
        async fn clock(&self) -> PortResult<ClockSysvar> {
            Ok(clock_at(GENESIS_TS))
        }
        async fn accounts(&self, keys: &[Address], _m: u64) -> PortResult<Vec<Option<Account>>> {
            Ok(vec![None; keys.len()])
        }
        async fn simulate(&self, _tx: &[u8]) -> PortResult<SimResult> {
            panic!("simulate must never be called")
        }
        async fn send(&self, _tx: &[u8]) -> PortResult<Signature> {
            panic!("send must never be called")
        }
        async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
            Ok(vec![])
        }
        async fn feed(&self, _after: Cursor) -> PortResult<Vec<TxRecord>> {
            Ok(self.0.clone())
        }
        async fn blockhash(&self) -> PortResult<(Hash, u64)> {
            Ok((Hash::default(), 0))
        }
    }
    let mut c = Chains::default();
    let overlap = Overlap(vec![c.depart_at(12), c.depart_at(13)]);
    assert_eq!(block_on(f.step(&overlap, &mut o, None, &scope(), false)), 1);
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_PAGE_ORDER, 12))
    );
    assert_eq!(
        (o.wide_txs, o.last_seq_seen),
        (0, None),
        "the observer was not shown it"
    );
    assert_eq!(f.cursor().0, 12);
    assert_eq!(block_on(f.step(&overlap, &mut o, None, &scope(), false)), 0);
    // A skipped number: the raw feed is the chain's global sequence filtered
    // to this program, so it is a range this reader cannot judge — counted
    // and reported, the page processed, no stop and no claim.
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(12));
    let skipped = FeedPort::new(vec![c.depart_at(14)], 1);
    // One data page followed by an empty page, rather than replaying it.
    assert_eq!(block_on(f.step(&skipped, &mut o, None, &scope(), false)), 2);
    assert!(f.stopped().is_none());
    assert_eq!(
        (o.wide_txs, o.last_seq_seen, f.cursor().0),
        (1, Some(14), 14)
    );
    assert_eq!(f.sequence_holes, 1);
    assert_eq!(f.status()["sequence_holes_unknown"], 1);
    assert!(f.status()["sequence_note"]
        .as_str()
        .unwrap()
        .contains("unknown to this reader"));
    // Out of order within the page.
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(12));
    let disorder = Overlap(vec![c.depart_at(13), c.depart_at(15), c.depart_at(14)]);
    assert_eq!(
        block_on(f.step(&disorder, &mut o, None, &scope(), false)),
        1
    );
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_PAGE_ORDER, 14))
    );
    assert_eq!(o.wide_txs, 0);
    assert_eq!(f.cursor().0, 12);
}

/// A feed error is counted and ends the tick; the port's text (which may
/// carry a URL with credentials) never reaches the status; the follower is
/// not stopped and pulls again next tick. Legacy and non-wide records pass
/// through the observer as its counts, the cursor advancing.
#[test]
fn follower_feed_errors_are_counted_without_text_and_non_wide_records_pass_through() {
    // A committed transaction of the program with no PSW1 body: the
    // observer's `Legacy`; no proof extracts from it.
    let legacy = {
        let mut r = record(wire_of(&[depart_ix(home())]), frame(&[]));
        r.seq = 21;
        r.slot = 1_021;
        r
    };
    let mut c = Chains::default();
    let port = FeedPort::new(vec![c.depart_at(20), legacy, c.depart_at(22)], 10);
    let mut o = follow_observer();
    let mut store = ProofStore::default();
    let mut f = WideFollow::new(Some(19));
    // A caught-up claim from an earlier step does not survive the error.
    let empty = FeedPort::new(vec![], 10);
    assert_eq!(block_on(f.step(&empty, &mut o, None, &scope(), false)), 1);
    assert!(f.caught_up);
    port.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        0
    );
    assert_eq!((f.read_errors, f.pages), (1, 1));
    assert!(!f.caught_up, "a failed read is not a current empty page");
    assert!(f.stopped().is_none());
    let text = f.status().to_string();
    assert!(
        !text.contains("hunter2") && !text.contains("feed.example") && !text.contains("token=")
    );
    assert_eq!(f.status()["read_errors"], 1);
    // Recovered: the page with a wireless (non-wide) record in the middle.
    port.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        2
    );
    assert_eq!(f.cursor().0, 22);
    assert_eq!(o.last_seq_seen, Some(22));
    assert_eq!((o.wide_txs, o.legacy_txs, o.decode_failures), (2, 1, 0));
    assert_eq!((store.records_offered, store.from_feed), (3, 2));
    assert!(o.model.blocked().is_none());
    assert_eq!(f.status()["max_page_records"], MAX_PAGE_RECORDS);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

/// A page longer than `MAX_PAGE_RECORDS` is refused **before** any record
/// is read: no order scan, the observer and the proof store untouched, the
/// cursor unchanged, a typed stop with the count and the first sequence
/// only; a page of exactly the bound is processed. The records are small
/// and literal; nothing about their content is consulted.
#[test]
fn an_oversized_page_is_refused_unread_before_the_observer_or_the_store_sees_it() {
    // A malicious server: a huge page of cheap wireless records, one of
    // them a duplicate sequence deep inside (never noticed: the length
    // bound comes before the order scan).
    let huge: Vec<TxRecord> = (0..MAX_PAGE_RECORDS as u64 + 1)
        .map(|i| {
            let mut r = record(vec![], vec![]);
            r.seq = if i == 500 { 100 } else { 100 + i };
            r.slot = 1_000 + i;
            r
        })
        .collect();
    let port = FeedPort::new(huge, MAX_PAGE_RECORDS + 1);
    let mut o = follow_observer();
    let mut store = ProofStore::default();
    let mut f = WideFollow::new(Some(99));
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        1
    );
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OVERSIZED, 100))
    );
    assert_eq!((f.oversized_pages, f.records, f.cursor().0), (1, 0, 99));
    assert_eq!(
        (o.last_seq_seen, o.legacy_txs, o.decode_failures),
        (None, 0, 0)
    );
    assert!(o.model.blocked().is_none(), "the observer never saw it");
    assert_eq!((store.records_seen, store.records_offered), (0, 0));
    // Stopped: no further pull.
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        0
    );
    assert_eq!(*port.asked.lock().unwrap(), vec![99]);
    let st = f.status();
    assert_eq!(st["stopped"]["code"], STOP_OVERSIZED);
    assert_eq!(st["oversized_pages"], 1);
    assert_eq!(st["records"], 0);
    assert!(
        !st.to_string().contains("1001"),
        "nothing of the page but its count and first sequence"
    );
    // Exactly the bound: processed (one wide record then legacy-shaped
    // ones with wires that decode as committed program transactions
    // without bodies).
    let mut chains = Chains::default();
    let exact: Vec<TxRecord> = (0..MAX_PAGE_RECORDS as u64)
        .map(|i| {
            let mut r = if i == 0 {
                chains.depart_at(200)
            } else {
                record(wire_of(&[depart_ix(home())]), frame(&[]))
            };
            r.seq = 200 + i;
            r.slot = 1_200 + i;
            r
        })
        .collect();
    let port = FeedPort::new(exact, MAX_PAGE_RECORDS);
    let mut o = follow_observer();
    let mut store = ProofStore::default();
    let mut f = WideFollow::new(Some(199));
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
        2
    );
    assert!(f.stopped().is_none());
    assert_eq!(f.cursor().0, 199 + MAX_PAGE_RECORDS as u64);
    assert_eq!(o.last_seq_seen, Some(199 + MAX_PAGE_RECORDS as u64));
    assert_eq!((o.wide_txs, o.legacy_txs), (1, MAX_PAGE_RECORDS as u64 - 1));
    assert_eq!(store.from_feed, 1);
    assert_eq!(
        store.records_offered as usize,
        keeper_core::widetick::MAX_EXTRACT_PER_PAGE,
        "the store's own per-page bound"
    );
}

/// The byte preflight refuses a record or a page past its bounds before
/// the observer fingerprints anything: every bound by a literal record
/// just past it, each a typed stop at that record's sequence with the
/// cursor, the observer and the store untouched; records at the bounds
/// pass; the status lists the bounds.
#[test]
fn the_byte_preflight_refuses_oversized_records_and_pages_before_the_observer() {
    let plain = |seq: u64| {
        let mut r = record(vec![], vec![]);
        r.seq = seq;
        r.slot = 1_000 + seq;
        r
    };
    let post = |n: usize, data: usize| -> Vec<(Address, Option<Account>)> {
        (0..n)
            .map(|i| {
                (
                    Address::new_from_array([i as u8; 32]),
                    Some(Account {
                        lamports: 1,
                        data: vec![0u8; data],
                        owner: program(),
                        executable: false,
                    }),
                )
            })
            .collect()
    };
    // The preflight itself, record by record.
    let mut r = plain(1);
    r.tx = vec![0; MAX_RECORD_WIRE_BYTES];
    assert!(preflight(&r).is_ok(), "at the wire bound");
    r.tx = vec![0; MAX_RECORD_WIRE_BYTES + 1];
    assert_eq!(preflight(&r), Err(STOP_RECORD_WIRE));
    let mut r = plain(1);
    r.logs = vec!["x".into(); MAX_RECORD_LOG_LINES];
    assert!(preflight(&r).is_ok(), "at the line-count bound");
    r.logs.push("x".into());
    assert_eq!(preflight(&r), Err(STOP_RECORD_LOGS));
    let mut r = plain(1);
    r.logs = vec!["x".repeat(MAX_RECORD_LOG_LINE_BYTES)];
    assert!(preflight(&r).is_ok(), "at the line-length bound");
    r.logs = vec!["x".repeat(MAX_RECORD_LOG_LINE_BYTES + 1)];
    assert_eq!(preflight(&r), Err(STOP_RECORD_LOGS));
    let mut r = plain(1);
    let line = "x".repeat(4_000);
    r.logs = vec![line.clone(); MAX_RECORD_LOG_BYTES / 4_000 + 1];
    assert_eq!(preflight(&r), Err(STOP_RECORD_LOGS), "aggregate log bytes");
    let mut r = plain(1);
    r.err = Some("e".repeat(MAX_RECORD_ERR_BYTES));
    assert!(preflight(&r).is_ok(), "at the error bound");
    r.err = Some("e".repeat(MAX_RECORD_ERR_BYTES + 1));
    assert_eq!(preflight(&r), Err(STOP_RECORD_ERR));
    let mut r = plain(1);
    r.post = post(MAX_RECORD_POST_ACCOUNTS, 0);
    assert!(preflight(&r).is_ok(), "at the account-count bound");
    r.post = post(MAX_RECORD_POST_ACCOUNTS + 1, 0);
    assert_eq!(preflight(&r), Err(STOP_RECORD_POST));
    let mut r = plain(1);
    r.post = post(3, MAX_RECORD_POST_DATA_BYTES / 3 + 1);
    assert_eq!(preflight(&r), Err(STOP_RECORD_POST), "aggregate post data");
    // Within every field bound but past the record's total: post data
    // near its bound plus logs near theirs.
    let mut r = plain(1);
    r.post = post(1, MAX_RECORD_POST_DATA_BYTES - 100);
    r.logs = vec![line.clone(); MAX_RECORD_LOG_BYTES / 4_000 - 1];
    assert_eq!(preflight(&r), Err(STOP_RECORD_BYTES));
    const { assert!(MAX_RECORD_BYTES <= MAX_RECORD_POST_DATA_BYTES + MAX_RECORD_LOG_BYTES) };
    // Through the follower: each refusal leaves everything untouched.
    let cases: Vec<(&str, TxRecord)> = vec![
        (STOP_RECORD_WIRE, {
            let mut r = plain(30);
            r.tx = vec![0; MAX_RECORD_WIRE_BYTES + 1];
            r
        }),
        (STOP_RECORD_LOGS, {
            let mut r = plain(30);
            r.logs = vec!["x".into(); MAX_RECORD_LOG_LINES + 1];
            r
        }),
        (STOP_RECORD_ERR, {
            let mut r = plain(30);
            r.err = Some("e".repeat(MAX_RECORD_ERR_BYTES + 1));
            r
        }),
        (STOP_RECORD_POST, {
            let mut r = plain(30);
            r.post = post(MAX_RECORD_POST_ACCOUNTS + 1, 0);
            r
        }),
        (STOP_RECORD_BYTES, {
            let mut r = plain(30);
            r.post = post(1, MAX_RECORD_POST_DATA_BYTES - 100);
            r.logs = vec![line.clone(); MAX_RECORD_LOG_BYTES / 4_000 - 1];
            r
        }),
    ];
    for (code, bad) in cases {
        // A fine record first, the bad one second: the whole page is
        // refused, the fine one included.
        let port = FeedPort::new(vec![Chains::default().depart_at(29), bad], 10);
        let mut o = follow_observer();
        let mut store = ProofStore::default();
        let mut f = WideFollow::new(Some(28));
        assert_eq!(
            block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
            1,
            "{code}"
        );
        assert_eq!(
            f.stopped().map(|s| (s.code, s.seq)),
            Some((code, 30)),
            "{code}"
        );
        assert_eq!(
            (f.cursor().0, f.records, f.bytes, f.preflight_rejections),
            (28, 0, 0, 1),
            "{code}"
        );
        assert_eq!(
            (o.last_seq_seen, o.wide_txs, o.legacy_txs),
            (None, 0, 0),
            "{code}"
        );
        assert!(o.model.blocked().is_none(), "{code}");
        assert_eq!(store.records_seen, 0, "{code}");
        assert_eq!(
            block_on(f.step(&port, &mut o, Some(&mut store), &scope(), false)),
            0,
            "{code}: stopped"
        );
        assert_eq!(*port.asked.lock().unwrap(), vec![28], "{code}");
        assert_eq!(f.status()["stopped"]["code"], code);
    }
    // The page aggregate: ten records each within its own bounds, together
    // past the page's; the stop names the record that crossed it.
    let per = MAX_PAGE_BYTES / 10 + 1;
    assert!(per < MAX_RECORD_POST_DATA_BYTES && per + 4_096 < MAX_RECORD_BYTES);
    let page: Vec<TxRecord> = (40..50u64)
        .map(|seq| {
            let mut r = plain(seq);
            r.post = post(1, per);
            assert!(preflight(&r).is_ok(), "each record alone is within bounds");
            r
        })
        .collect();
    let port = FeedPort::new(page, 10);
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(39));
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 1);
    assert_eq!(f.stopped().map(|s| s.code), Some(STOP_PAGE_BYTES));
    assert_eq!(
        f.stopped().map(|s| s.seq),
        Some(49),
        "the tenth record crossed it"
    );
    assert_eq!((f.cursor().0, f.records, f.bytes), (39, 0, 0));
    assert_eq!((o.last_seq_seen, o.legacy_txs), (None, 0));
    // The status lists every bound.
    let b = &f.status()["bounds"];
    assert_eq!(b["record_wire_bytes"], MAX_RECORD_WIRE_BYTES);
    assert_eq!(b["record_log_lines"], MAX_RECORD_LOG_LINES);
    assert_eq!(b["record_log_line_bytes"], MAX_RECORD_LOG_LINE_BYTES);
    assert_eq!(b["record_log_bytes"], MAX_RECORD_LOG_BYTES);
    assert_eq!(b["record_err_bytes"], MAX_RECORD_ERR_BYTES);
    assert_eq!(b["record_post_accounts"], MAX_RECORD_POST_ACCOUNTS);
    assert_eq!(b["record_post_data_bytes"], MAX_RECORD_POST_DATA_BYTES);
    assert_eq!(b["record_bytes"], MAX_RECORD_BYTES);
    assert_eq!(b["page_bytes"], MAX_PAGE_BYTES);
    // Ordinary records pass and are measured.
    let mut c = Chains::default();
    let pair = vec![c.depart_at(60), c.depart_at(61)];
    let port = FeedPort::new(pair.clone(), 10);
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(59));
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 2);
    assert!(f.stopped().is_none());
    assert_eq!((f.records, f.preflight_rejections), (2, 0));
    let expect: usize = pair.iter().map(|r| preflight(r).unwrap()).sum();
    assert_eq!(f.bytes as usize, expect);
    assert_eq!(o.last_seq_seen, Some(61));
}

/// One transaction carrying several PSW1 events: event ordinals are not
/// archive sequences and an event-page cursor is not a transaction feed
/// cursor; a batch's atomicity is per transaction on the observer and per
/// page on the index. **Literal synthetic bodies**: valid public ABI
/// encodings (`frontier_abi::world_index::event`), chained with the ABI's
/// `advance`, inside a literal frame — not the output of any handler
/// execution, and no claim that a real program emits these stages
/// together.
#[test]
fn a_multi_event_transaction_separates_event_ordinals_from_archive_and_feed_cursors() {
    // Transaction A: three events of one host — Muster, Departed,
    // DepartureSettled — one frame; transaction B: one Departed.
    let mut c = Chains::default();
    let muster = c.body(
        WideKind::Muster,
        DEPART_BELL - 1,
        &wev::host_key(&host(), home()),
        &wev::muster_payload(2, TROOPS / 1_000, 5, 4, 7),
    );
    let departed = c.departed();
    let settled = c.body(
        WideKind::DepartureSettled,
        DEPART_BELL + 1,
        &wev::host_key(&host(), home()),
        &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
    );
    let with_bodies = |seq: u64, bodies: &[Vec<u8>]| {
        let mut r = record(wire_of(&[depart_ix(home())]), frame(bodies));
        r.seq = seq;
        r.slot = 1_000 + seq;
        sign_as(&mut r, seq);
        r
    };
    let tx_a = with_bodies(10, &[muster, departed, settled]);
    let tx_b = with_bodies(20, &[c.departed()]);
    // 1. The store: two archived transactions, four indexed events.
    let dir = parity_dir("multi");
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let mut rows = Rows {
        rows: vec![tx_a.clone(), tx_b.clone()],
        after: 0,
        pulls: 0,
        fail_next: false,
    };
    let stored = block_on(store.ingest(&mut rows)).unwrap();
    store.commit().unwrap();
    assert_eq!(stored.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(
        store.archive().last_seq(),
        2,
        "archive sequence: transactions"
    );
    let all = store.index.events(0, 10).unwrap();
    assert_eq!(all.events.len(), 4, "event ordinal: records");
    assert_eq!(
        all.events
            .iter()
            .map(|e| (e.event, e.archive_seq, e.ordinal))
            .collect::<Vec<_>>(),
        vec![(1, 1, 0), (2, 1, 1), (3, 1, 2), (4, 2, 0)]
    );
    assert!(all
        .events
        .iter()
        .all(|e| e.host == Some(host().to_bytes().to_vec())));
    assert_eq!(all.indexed_through, 2);
    // 2. A page boundary inside transaction A: `next` is an event number
    //    (2) that happens to equal `indexed_through` (2 transactions) and
    //    means something else. Fed to the archive as a transaction cursor
    //    it reads nothing although two events remain; fed back to
    //    `events` it reads exactly those two.
    let page = store.index.events(0, 2).unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(page.more);
    assert_eq!(page.next, 2);
    assert_eq!(page.indexed_through, 2);
    assert!(
        store.archive().read_after(page.next).unwrap().is_empty(),
        "an event cursor is not a transaction cursor: after archive seq 2 there is nothing, yet events remain"
    );
    let rest = store.index.events(page.next, 10).unwrap();
    assert_eq!(
        rest.events.iter().map(|e| e.event).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!rest.more);
    assert_eq!(
        rows.after, 20,
        "and the source cursor is the raw feed sequence, a third numbering"
    );
    // 3. The observer over the archived transactions: two transactions,
    //    four records, the chains advanced four times, equal to the index.
    let archived = store.archive().read_after(0).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&archived, &program()), 2);
    assert_eq!(o.last_seq_seen, Some(2), "transactions, not events");
    assert_eq!(o.model.coverage().records, 4, "records, not transactions");
    let idx = store
        .index
        .chain(WideTarget::Province(home()))
        .unwrap()
        .unwrap();
    let obs = o.chain(WideTarget::Province(home())).unwrap();
    assert_eq!((obs.seq, obs.head, obs.from_genesis), (4, idx.head, true));
    assert_eq!(
        (
            o.chain_anchored_from_genesis,
            o.chain_anchored_unverified,
            o.chain_verified
        ),
        (2, 0, 6)
    );
    drop(store);
    std::fs::remove_dir_all(&dir).unwrap();
    // 4. Atomicity, stated as it is. A batch [A, C] with C's link broken:
    //    the index rolls back the **whole page** (A's three events too);
    //    the observer applies A whole (three events, chains at 3) and
    //    blocks at C — atomic per transaction, not per page.
    let mut c2 = Chains::default();
    let a_bodies = [
        c2.body(
            WideKind::Muster,
            DEPART_BELL - 1,
            &wev::host_key(&host(), home()),
            &wev::muster_payload(2, TROOPS / 1_000, 5, 4, 7),
        ),
        c2.departed(),
        c2.body(
            WideKind::DepartureSettled,
            DEPART_BELL + 1,
            &wev::host_key(&host(), home()),
            &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
        ),
    ];
    let mut broken = c2.departed();
    *broken.last_mut().unwrap() ^= 1;
    let tx_a2 = with_bodies(1, &a_bodies);
    let tx_c = with_bodies(2, &[broken]);
    let p = parity_dir("multi-atomic");
    let mut idx = WideIndex::open(&p, program(), world()).unwrap();
    assert!(idx.add(&[tx_a2.clone(), tx_c.clone()]).is_err());
    let st = idx.status().unwrap();
    assert_eq!(st.last_seq, 0, "the page rolled back whole");
    assert!(st.blocked.is_some());
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[tx_a2, tx_c], &program()), 1);
    assert_eq!(o.accepted_prefix, 1);
    assert_eq!(
        o.model.coverage().records,
        3,
        "A's three events applied whole"
    );
    assert_eq!(o.chain(WideTarget::Province(home())).unwrap().seq, 3);
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(2));
}

/// The first link seen for an entity: sequence 0 is impossible and refused;
/// sequence 1 must be the ABI's step from the zero head and a wrong head
/// there is refused; the refusal takes the whole transaction (no head of
/// it is kept, for either entity); only a sequence past 1 is a mid-history
/// anchor taken on trust.
#[test]
fn chain_anchors_refuse_sequence_zero_and_a_wrong_first_head_for_the_whole_transaction() {
    let key = wev::host_key(&host(), home());
    let payload = wev::departed_payload(
        SLOT,
        DEPART_BELL,
        ARRIVE_BELL,
        TROOPS,
        61,
        TIP,
        7_000,
        11_000,
        &root(),
    );
    let zero_links: Vec<WideLink> = WideKind::Departed
        .links()
        .iter()
        .map(|e| WideLink {
            entity: *e,
            seq: 0,
            head: [0; 32],
        })
        .collect();
    let seq_zero = encode(WideKind::Departed, DEPART_BELL, &key, &payload, &zero_links).unwrap();
    let mut c = Chains::default();
    // (a) Sequence 0 on both entities: refused, nothing anchored.
    let mut o = follow_observer();
    let r = c.depart_record_with(1, seq_zero);
    assert_eq!(o.observe_page(&[r], &program()), 0);
    let b = o.model.blocked().expect("blocked");
    assert!(b.reason.contains("sequence 0"), "{}", b.reason);
    assert!(o.chain(WideTarget::Province(home())).is_none());
    assert!(o.chain(WideTarget::Holding(host())).is_none());
    assert!(o.model.hosts.is_empty());
    assert_eq!(
        (o.chain_anchored_from_genesis, o.chain_anchored_unverified),
        (0, 0)
    );
    // (b) Sequence 1 with a head that is not the step from the zero head
    //     (the literal `both` links): refused, nothing anchored.
    let mut o = follow_observer();
    let r = record(wire_of(&[depart_ix(home())]), frame(&[departed_ok(home())]));
    assert_eq!(o.observe_page(&[r], &program()), 0);
    let b = o.model.blocked().expect("blocked");
    assert!(
        b.reason.contains("does not follow the zero head"),
        "{}",
        b.reason
    );
    assert!(o.chain(WideTarget::Province(home())).is_none());
    assert!(o.model.hosts.is_empty());
    // (c) The province link right from zero, the holding link's head wrong:
    //     the whole transaction refused — the province head is not kept
    //     either (atomic per transaction, both entities).
    let mut c2 = Chains::default();
    let mut body = c2.departed();
    *body.last_mut().unwrap() ^= 1; // the last head byte: the holding link's
    let mut o = follow_observer();
    assert_eq!(
        o.observe_page(&[c2.depart_record_with(1, body)], &program()),
        0
    );
    let b = o.model.blocked().expect("blocked");
    assert!(
        b.reason.contains("Holding") && b.reason.contains("zero head"),
        "{}",
        b.reason
    );
    assert!(
        o.chain(WideTarget::Province(home())).is_none(),
        "no head of the refused transaction"
    );
    assert!(o.chain(WideTarget::Holding(host())).is_none());
    assert!(o.model.hosts.is_empty());
    // (d) A right first step from zero: anchored from genesis, both entities.
    let mut c3 = Chains::default();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[c3.depart_at(1)], &program()), 1);
    assert_eq!(
        (o.chain_anchored_from_genesis, o.chain_anchored_unverified),
        (2, 0)
    );
    assert!(o.chain(WideTarget::Province(home())).unwrap().from_genesis);
    assert!(o.chain(WideTarget::Holding(host())).unwrap().from_genesis);
    // (e) Only a sequence past 1 is a mid-history anchor taken on trust.
    let mut c4 = Chains::default();
    let _first = c4.depart_at(1);
    let second = c4.depart_at(2);
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[second], &program()), 1);
    assert_eq!(
        (o.chain_anchored_from_genesis, o.chain_anchored_unverified),
        (0, 2)
    );
    assert!(!o.chain(WideTarget::Province(home())).unwrap().from_genesis);
}

/// Sets an account's chain header fields (`EVENT_SEQ`, `EVENT_HEAD`) in a
/// literal account map — the bytes `emit_wide` would have left.
fn set_chain(
    accounts: &mut BTreeMap<Address, Option<Account>>,
    a: Address,
    seq: u64,
    head: [u8; 32],
) {
    let acc = accounts.get_mut(&a).unwrap().as_mut().unwrap();
    assert!(wr_u64(&mut acc.data, header::EVENT_SEQ, seq));
    assert!(wr_arr(&mut acc.data, header::EVENT_HEAD, &head));
}

fn clock_slot(slot: u64) -> ClockSysvar {
    ClockSysvar {
        slot,
        unix_timestamp: GENESIS_TS,
        ..ClockSysvar::default()
    }
}

/// The observed chain head of a province or holding against the account's
/// own chain fields in one coherent snapshot: every verdict on literal
/// bytes — agree (from genesis, and from an anchor taken on trust, said
/// so), the account ahead, the account behind, a modified head, a response
/// older than the record, wrong owner / generation / coordinate, an absent
/// account with and without an observed close, nothing observed, no
/// coherent snapshot, the address not read — and nothing moved on the
/// observer or the reads. Agreement is cross-input consistency only: the
/// records' and the snapshot's source relationship is unverified.
#[test]
fn reconciliation_compares_observed_heads_with_a_coherent_snapshot_as_cross_input_consistency() {
    let mut c = Chains::default();
    let r1 = c.depart_at(1);
    let r2 = c.depart_at(2);
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[r1.clone(), r2.clone()], &program()), 2);
    let hp = o.chain(WideTarget::Province(home())).unwrap();
    let hh = o.chain(WideTarget::Holding(host())).unwrap();
    assert_eq!((hp.seq, hp.slot, hp.from_genesis), (2, 1_002, true));
    assert_eq!((hh.seq, hh.slot), (2, 1_002));
    let before = (o.last_seq_seen, o.model.cursor(), o.status());
    let fx = SettleFx::new(home());
    let base = fx.reads().accounts;
    let keys: Vec<Address> = base.keys().copied().collect();
    let province = province_addr(home());
    let holding = fx.holding_addr();
    // The accounts as `emit_wide` left them after record 2, in a response
    // at slot 2,000 (past the record's 1,002).
    let mut agree = base.clone();
    set_chain(&mut agree, province, hp.seq, hp.head);
    set_chain(&mut agree, holding, hh.seq, hh.head);
    let snap = snapshot_of(&agree, &keys, clock_slot(2_000), 7);
    let reads = snap.reads();
    let reads_before = reads.clone();
    let rp = reconcile(&dscope(), &o, WideTarget::Province(home()), &reads);
    assert_eq!(rp.verdict, Verdict::Agree);
    assert_eq!(rp.address, province);
    assert_eq!(rp.account, Some((hp.seq, hp.head)));
    assert_eq!(rp.context_slot, Some(2_000));
    let d = rp.describe();
    assert_eq!(d["verdict"], "Agree");
    assert_eq!(d["disagreement"], false);
    assert_eq!(d["lag"], false);
    assert!(d["meaning"]
        .as_str()
        .unwrap()
        .contains("cross-input consistency"));
    assert!(d["source_relationship"]
        .as_str()
        .unwrap()
        .contains("unverified"));
    assert_eq!(d["history_authenticated"], false);
    assert_eq!(d["source_complete"], false);
    assert_eq!(d["permits"], "nothing");
    assert_eq!(d["observed"]["from_genesis"], true);
    assert_eq!(d["observed"]["record_slot_asserted"], 1_002);
    let rh = reconcile(&dscope(), &o, WideTarget::Holding(host()), &reads);
    assert_eq!(rh.verdict, Verdict::Agree);
    assert_eq!(rh.address, holding);
    // Nothing moved: the observer and the reads are as they were.
    assert_eq!((o.last_seq_seen, o.model.cursor(), o.status()), before);
    assert_eq!(reads, reads_before);
    // The response older than the record: nothing concluded, said so.
    let snap_old = snapshot_of(&agree, &keys, clock_slot(900), 7);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snap_old.reads(),
    );
    assert_eq!(
        r.verdict,
        Verdict::SnapshotBehindRecord {
            context_slot: 900,
            record_slot: 1_002
        }
    );
    assert!(!r.verdict.is_disagreement());
    // A modified head at the same sequence.
    let mut flipped = hp.head;
    flipped[31] ^= 1;
    let mut m = base.clone();
    set_chain(&mut m, province, hp.seq, flipped);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&m, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::HeadMismatch);
    assert!(r.verdict.is_disagreement());
    // The account's chain past the observed link: the observer is behind.
    let mut ahead = base.clone();
    set_chain(&mut ahead, province, 3, [0x33; 32]);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&ahead, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::ObserverBehind { account_seq: 3 });
    assert!(
        r.verdict.is_lag() && !r.verdict.is_disagreement(),
        "lag is not a conflict"
    );
    assert_eq!(r.describe()["lag"], true);
    // The account's chain behind the observed link at a slot past the
    // record: not one history.
    let mut behind = base.clone();
    set_chain(&mut behind, province, 1, [0x11; 32]);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&behind, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::AccountBehind { account_seq: 1 });
    assert!(r.verdict.is_disagreement());
    // Wrong owner at the canonical address.
    let mut foreign = agree.clone();
    foreign.get_mut(&province).unwrap().as_mut().unwrap().owner = actor();
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&foreign, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::Identity("owner"));
    // An executable account at the canonical address, even program-owned.
    let mut exec = agree.clone();
    exec.get_mut(&province)
        .unwrap()
        .as_mut()
        .unwrap()
        .executable = true;
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&exec, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::Identity("executable"));
    assert!(r.verdict.is_disagreement());
    // Executable System-owned empty data must not normalize to absence.
    let a = exec.get_mut(&province).unwrap().as_mut().unwrap();
    a.owner = Address::from([0; 32]);
    a.data.clear();
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&exec, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::Identity("executable"));
    // Another generation of the holding at the address.
    let mut gen = agree.clone();
    gen.insert(
        holding,
        acct(holding_bytes(
            home().coord(),
            GEN + 1,
            H::STATE_FINAL,
            citizen(),
        )),
    );
    set_chain(&mut gen, holding, hh.seq, hh.head);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Holding(host()),
        &snapshot_of(&gen, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::Identity("generation"));
    // Another province's record at the address.
    let mut other = agree.clone();
    other.insert(province, acct(province_bytes(away(), DEPART_BELL + 1)));
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&other, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::Identity("coordinate"));
    // Absent, no close observed: missing (unknown which way).
    let mut absent = agree.clone();
    absent.insert(province, None);
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&absent, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::AccountMissing);
    assert!(!r.verdict.is_disagreement());
    // Absent after an observed `ProvinceClosed`: closed.
    let mut c2 = Chains::default();
    let d1 = c2.departed();
    let closed = c2.body(
        WideKind::ProvinceClosed,
        DEPART_BELL + 1,
        &home().to_bytes(),
        &wev::province_closed_payload(&[0xd5; 32], 5),
    );
    let mut o2 = follow_observer();
    assert_eq!(
        o2.observe_page(
            &[
                c2.depart_record_with(1, d1),
                c2.depart_record_with(2, closed)
            ],
            &program()
        ),
        2
    );
    assert!(o2.chain(WideTarget::Province(home())).unwrap().terminal);
    let r = reconcile(
        &dscope(),
        &o2,
        WideTarget::Province(home()),
        &snapshot_of(&absent, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::AccountClosed);
    // The same absence in a response older than the close record: an old
    // absence cannot confirm a later close — stale, not closed.
    let r = reconcile(
        &dscope(),
        &o2,
        WideTarget::Province(home()),
        &snapshot_of(&absent, &keys, clock_slot(900), 7).reads(),
    );
    assert_eq!(
        r.verdict,
        Verdict::SnapshotBehindRecord {
            context_slot: 900,
            record_slot: 1_002
        }
    );
    // Likewise an old absence against a non-terminal observation is not
    // "missing": stale.
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&absent, &keys, clock_slot(900), 7).reads(),
    );
    assert!(matches!(r.verdict, Verdict::SnapshotBehindRecord { .. }));
    // The province closed in the observation yet present in the response
    // at or past the close: the close erases the account in its own
    // transaction, so the two inputs disagree.
    let r = reconcile(
        &dscope(),
        &o2,
        WideTarget::Province(home()),
        &snapshot_of(&agree, &keys, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::ClosedButPresent);
    assert!(r.verdict.is_disagreement());
    // An observer of another scope (another program): its heads do not
    // apply, whatever they say.
    let foreign_observer = WideObserver::new(
        IndexScope {
            program: actor(),
            season: season_pda().0,
            world: world(),
            source: "test: another program".into(),
        },
        Limits::default(),
    );
    let r = reconcile(
        &dscope(),
        &foreign_observer,
        WideTarget::Province(home()),
        &reads,
    );
    assert_eq!(r.verdict, Verdict::ScopeMismatch("program"));
    assert!(
        r.observed.is_none(),
        "no head of a foreign observer is used"
    );
    let other_world = ProvinceKey::new(other_world(), home().coord());
    let r = reconcile(&dscope(), &o, WideTarget::Province(other_world), &reads);
    assert_eq!(r.verdict, Verdict::ScopeMismatch("target world"));
    // Nothing observed for the entity.
    let o3 = follow_observer();
    let r = reconcile(&dscope(), &o3, WideTarget::Province(home()), &reads);
    assert_eq!(r.verdict, Verdict::NotObserved);
    assert_eq!(
        r.account,
        Some((hp.seq, hp.head)),
        "the account was still read"
    );
    // Reads that are not one coherent snapshot: no comparison.
    let r = reconcile(&dscope(), &o, WideTarget::Province(home()), &fx.reads());
    assert_eq!(r.verdict, Verdict::NoCoherentSnapshot);
    assert_eq!(r.observed, Some(hp));
    // The address not in the reads.
    let mut fewer = agree.clone();
    fewer.remove(&province);
    let keys_fewer: Vec<Address> = fewer.keys().copied().collect();
    let r = reconcile(
        &dscope(),
        &o,
        WideTarget::Province(home()),
        &snapshot_of(&fewer, &keys_fewer, clock_slot(2_000), 7).reads(),
    );
    assert_eq!(r.verdict, Verdict::NotRead);
    // An anchor taken on trust: an observer that saw record 2 alone agrees
    // with the same account bytes — and says its anchor is unverified.
    let mut o4 = follow_observer();
    assert_eq!(o4.observe_page(&[r2], &program()), 1);
    let h4 = o4.chain(WideTarget::Province(home())).unwrap();
    assert!(!h4.from_genesis);
    assert_eq!((h4.seq, h4.head), (hp.seq, hp.head));
    let r = reconcile(&dscope(), &o4, WideTarget::Province(home()), &reads);
    assert_eq!(r.verdict, Verdict::Agree);
    let d = r.describe();
    assert_eq!(d["observed"]["from_genesis"], false);
    assert!(d["observed"]["anchor"]
        .as_str()
        .unwrap()
        .contains("unverified"));
    assert_eq!(d["history_authenticated"], false);
}

/// The tick carries the reconciliation of each candidate's accounts when
/// the observer is lent, counts the verdicts, and admits nothing more for
/// an agreement; without the observer the entry says `null`.
#[test]
fn the_tick_reconciles_a_candidates_accounts_as_diagnostics_only() {
    let mut c = Chains::default();
    let mut r1 = c.depart_at(1);
    r1.slot = 5; // a record before the fixture response's slot (900)
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[r1], &program()), 1);
    let hp = o.chain(WideTarget::Province(home())).unwrap();
    let hh = o.chain(WideTarget::Holding(host())).unwrap();
    assert_eq!(hp.slot, 5);
    let fx = SettleFx::new(home());
    let mut accounts = fx.reads().accounts;
    set_chain(&mut accounts, province_addr(home()), hp.seq, hp.head);
    set_chain(&mut accounts, fx.holding_addr(), hh.seq, hh.head);
    let port = FakePort {
        accounts: accounts.clone(),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let lit = LiteralSnapshots::new(accounts);
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review.step_observing(
        &port,
        &engine,
        &o.model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
        Some(&o),
    ));
    assert_eq!(made, 1);
    assert_eq!(
        (
            review.reconcile_agree,
            review.reconcile_disagree,
            review.reconcile_unknown
        ),
        (2, 0, 0)
    );
    let st = review.status();
    let r = &st["recent"][0];
    assert_eq!(r["candidate"]["coherent"], true);
    let rec = r["reconcile"].as_array().unwrap();
    assert_eq!(rec.len(), 2);
    assert!(rec.iter().all(|x| x["verdict"] == "Agree"));
    assert!(rec.iter().all(|x| x["source_relationship"]
        .as_str()
        .unwrap()
        .contains("unverified")));
    assert!(rec.iter().all(|x| x["history_authenticated"] == false));
    assert_eq!(rec[0]["target"]["province"], hex::encode(home().to_bytes()));
    assert_eq!(
        rec[1]["target"]["holding"],
        hex::encode(host().holding_ref().to_bytes())
    );
    // Agreement admits nothing: every hard denial stands.
    let denials = r["assessment"]["review"]["denials"].as_array().unwrap();
    for d in [
        "SourceUnproven",
        "HistoryUnknown",
        "SignerAbsent",
        "SliceDoesNotEnqueue",
    ] {
        assert!(denials.iter().any(|x| x == d), "{d}");
    }
    assert_eq!(r["assessment"]["review"]["admitted"], false);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(st["reconcile"]["agree"], 2);
    assert_eq!(st["reconcile"]["lag"], 0);
    assert!(st["reconcile"]["meaning"]
        .as_str()
        .unwrap()
        .contains("never history authenticity"));
    assert!(st["reconcile"]["meaning"]
        .as_str()
        .unwrap()
        .contains("source relationship is unverified"));
    // The observer was only lent: nothing of it moved.
    assert_eq!(o.last_seq_seen, Some(1));
    assert_eq!(o.model.cursor(), Some(1));
    // A head modified on the chain side: a disagreement, counted, still
    // nothing admitted.
    let mut tampered = fx.reads().accounts;
    let mut flipped = hp.head;
    flipped[0] ^= 1;
    set_chain(&mut tampered, province_addr(home()), hp.seq, flipped);
    set_chain(&mut tampered, fx.holding_addr(), hh.seq, hh.head);
    let lit2 = LiteralSnapshots::new(tampered);
    let mut review2 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review2.step_observing(
        &port,
        &engine,
        &o.model,
        program(),
        season_pda().0,
        900,
        Some(&lit2),
        None,
        Some(&o),
    ));
    assert_eq!(made, 1);
    assert_eq!(
        (review2.reconcile_agree, review2.reconcile_disagree),
        (1, 1)
    );
    let r2 = &review2.status()["recent"][0];
    assert_eq!(r2["reconcile"][0]["verdict"], "HeadMismatch");
    assert_eq!(r2["reconcile"][0]["disagreement"], true);
    assert_eq!(r2["assessment"]["review"]["admitted"], false);
    // The account's chain ahead of the observer: lag, counted apart from
    // disagreement, nothing admitted.
    let mut ahead = fx.reads().accounts;
    set_chain(&mut ahead, province_addr(home()), hp.seq + 1, [0x42; 32]);
    set_chain(&mut ahead, fx.holding_addr(), hh.seq, hh.head);
    let lit3 = LiteralSnapshots::new(ahead);
    let mut review_lag = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(
        block_on(review_lag.step_observing(
            &port,
            &engine,
            &o.model,
            program(),
            season_pda().0,
            900,
            Some(&lit3),
            None,
            Some(&o),
        )),
        1
    );
    assert_eq!(
        (
            review_lag.reconcile_agree,
            review_lag.reconcile_lag,
            review_lag.reconcile_disagree
        ),
        (1, 1, 0)
    );
    let rl = &review_lag.status()["recent"][0];
    assert_eq!(
        rl["reconcile"][0]["verdict"],
        format!("ObserverBehind {{ account_seq: {} }}", hp.seq + 1)
    );
    assert_eq!(rl["reconcile"][0]["lag"], true);
    assert_eq!(rl["reconcile"][0]["disagreement"], false);
    assert_eq!(rl["assessment"]["review"]["admitted"], false);
    assert_eq!(review_lag.status()["reconcile"]["lag"], 1);
    // Without the observer: no reconciliation, nothing counted.
    let mut review3 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review3.step(
        &port,
        &engine,
        &o.model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert!(review3.status()["recent"][0]["reconcile"].is_null());
    assert_eq!(
        (
            review3.reconcile_agree,
            review3.reconcile_lag,
            review3.reconcile_disagree,
            review3.reconcile_unknown
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

/// A wide transaction past the model's input caps is refused by the
/// observer by lengths alone — before any chain work: no head anchored or
/// verified, no model change, the block naming the cap; the follower stops
/// at it with its cursor unchanged. Both the body-count cap and the
/// aggregate-bytes cap.
#[test]
fn an_oversized_wide_batch_is_refused_before_any_chain_work() {
    // 65 chained departures in one transaction's frame: one over the
    // default `max_bodies_per_batch`.
    let mut c = Chains::default();
    let bodies: Vec<Vec<u8>> = (0..65).map(|_| c.departed()).collect();
    let mut r = record(wire_of(&[depart_ix(home())]), frame(&bodies));
    r.seq = 7;
    r.slot = 1_007;
    sign_as(&mut r, 7);
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[r.clone()], &program()), 0);
    let b = o.model.blocked().expect("blocked at the oversized batch");
    assert_eq!(b.seq, 7);
    assert!(b.reason.contains("bodies per batch") && b.reason.contains("65"));
    assert!(
        o.chain(WideTarget::Province(home())).is_none(),
        "no head anchored"
    );
    assert_eq!(
        (
            o.chain_anchored_from_genesis,
            o.chain_anchored_unverified,
            o.chain_verified
        ),
        (0, 0, 0)
    );
    assert!(o.model.hosts.is_empty(), "no model change");
    assert_eq!((o.accepted_prefix, o.wide_txs), (0, 0));
    let st = o.status();
    assert_eq!(st["chain"]["keys"], 0);
    // Through the follower: stopped at the observer's block, cursor as it was.
    let mut o2 = follow_observer();
    let mut f = WideFollow::new(Some(6));
    assert_eq!(
        block_on(f.step(&LiteralFeed(vec![r]), &mut o2, None, &scope(), false)),
        1
    );
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 7))
    );
    assert_eq!(f.cursor().0, 6);
    assert!(o2.chain(WideTarget::Province(home())).is_none());
    // The aggregate-bytes cap under a tight limit: two bodies within the
    // per-body cap, together over the batch cap; refused the same way.
    let mut c = Chains::default();
    let two: Vec<Vec<u8>> = (0..2).map(|_| c.departed()).collect();
    let one_len = two[0].len();
    let mut r2 = record(wire_of(&[depart_ix(home())]), frame(&two));
    r2.seq = 8;
    r2.slot = 1_008;
    sign_as(&mut r2, 8);
    let mut o3 = WideObserver::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: tight batch bytes".into(),
        },
        Limits {
            max_batch_bytes: one_len + one_len / 2,
            ..Limits::default()
        },
    );
    assert_eq!(o3.observe_page(&[r2], &program()), 0);
    assert!(o3
        .model
        .blocked()
        .unwrap()
        .reason
        .contains("bytes of the batch"));
    assert!(o3.chain(WideTarget::Province(home())).is_none());
    assert_eq!(o3.chain_verified + o3.chain_anchored_from_genesis, 0);
    // The same record within a default observer is fine: the cap, not the
    // content, was the refusal.
    let mut c = Chains::default();
    let two: Vec<Vec<u8>> = (0..2).map(|_| c.departed()).collect();
    let mut ok = record(wire_of(&[depart_ix(home())]), frame(&two));
    ok.seq = 8;
    ok.slot = 1_008;
    sign_as(&mut ok, 8);
    let mut o4 = follow_observer();
    assert_eq!(o4.observe_page(&[ok], &program()), 1);
    assert_eq!(o4.chain(WideTarget::Province(home())).unwrap().seq, 2);
}

/// The observer's block is final for the follower whatever produced it: a
/// conflicting replay through the **legacy** path (a divergent legacy
/// cursor re-serving a sequence with other bytes) blocks the observer
/// between two follower ticks; the follower's next step stops at that
/// sequence, pulls nothing, and never reinterprets or clears the block.
#[test]
fn a_legacy_replay_that_blocks_the_observer_stops_the_follower_without_reinterpretation() {
    let mut c = Chains::default();
    let recs: Vec<TxRecord> = (11..=14).map(|s| c.depart_at(s)).collect();
    let port = FeedPort::new(recs.clone(), 10);
    let mut o = follow_observer();
    let mut f = WideFollow::new(Some(10));
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 2);
    assert_eq!((f.cursor().0, o.last_seq_seen), (14, Some(14)));
    // The legacy path replays seq 12 with other bytes (a different slot):
    // a conflicting replay, the observer blocks there.
    let mut conflicting = recs[1].clone();
    conflicting.slot = 9_999;
    assert_eq!(o.observe_page(&[conflicting], &program()), 0);
    assert_eq!(o.model.blocked().map(|b| b.seq), Some(12));
    assert!(o.model.blocked().unwrap().reason.contains("conflicting"));
    // The follower stood aside in that tick (the legacy path pulled).
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), true)), 0);
    assert!(f.stopped().is_none(), "idle: nothing judged");
    // Its next own step: stopped at the observer's block, nothing pulled,
    // the cursor as it was, the block untouched.
    let before = o.model.blocked().map(|b| (b.seq, b.slot, b.reason.clone()));
    assert_eq!(block_on(f.step(&port, &mut o, None, &scope(), false)), 0);
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 12))
    );
    assert_eq!(f.cursor().0, 14);
    assert_eq!(*port.asked.lock().unwrap(), vec![10, 14]);
    assert_eq!(
        o.model.blocked().map(|b| (b.seq, b.slot, b.reason.clone())),
        before,
        "never cleared or rewritten"
    );
    assert!(!f.caught_up);
    // A fresh follower over the same blocked observer stops at once too.
    let mut f2 = WideFollow::from_observer(&o);
    assert_eq!(block_on(f2.step(&port, &mut o, None, &scope(), false)), 0);
    assert_eq!(f2.stopped().map(|s| s.code), Some(STOP_OBSERVER_BLOCKED));
    assert_eq!(*port.asked.lock().unwrap(), vec![10, 14]);
}

// ------------------------------------------------------------ archive / index parity

/// A literal `findex::Source` over fixed records (a **fixture**, labelled
/// so: never a live or complete feed): records past its cursor, oldest
/// first; `fail_next` makes one pull a lost response.
struct Rows {
    rows: Vec<TxRecord>,
    after: u64,
    pulls: usize,
    fail_next: bool,
}
impl Source for Rows {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        self.pulls += 1;
        if self.fail_next {
            self.fail_next = false;
            return Err(PortError::Io(
                "http://user:hunter2@archive.example/ lost the response".into(),
            ));
        }
        let out: Vec<_> = self
            .rows
            .iter()
            .filter(|r| r.seq > self.after)
            .cloned()
            .collect();
        if let Some(r) = out.last() {
            self.after = r.seq;
        }
        Ok(out)
    }
    fn cursor(&self) -> JsonValue {
        json!({"after": self.after, "fixture": "literal rows; not a live feed"})
    }
    fn restore(&mut self, v: &JsonValue) {
        self.after = v["after"].as_u64().unwrap_or(0);
    }
}

/// A feed port that serves exactly the page it holds, whatever the cursor
/// (to present duplicates, gaps and conflicts the filtering fake cannot).
struct LiteralFeed(Vec<TxRecord>);
impl ChainPort for LiteralFeed {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(clock_at(GENESIS_TS))
    }
    async fn accounts(&self, keys: &[Address], _m: u64) -> PortResult<Vec<Option<Account>>> {
        Ok(vec![None; keys.len()])
    }
    async fn simulate(&self, _tx: &[u8]) -> PortResult<SimResult> {
        panic!("simulate must never be called")
    }
    async fn send(&self, _tx: &[u8]) -> PortResult<Signature> {
        panic!("send must never be called")
    }
    async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(vec![])
    }
    async fn feed(&self, _after: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(self.0.clone())
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::default(), 0))
    }
}

fn parity_dir(tag: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "wide-parity-{tag}-{}-{n}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

/// A truncated PSW1 body in a committed frame at `seq`: the typed reader
/// refuses it on both sides.
fn malformed_at(seq: u64) -> TxRecord {
    let mut r = record(wire_of(&[depart_ix(home())]), frame(&[vec![0x82, 255]]));
    r.seq = seq;
    r.slot = 1_000 + seq;
    sign_as(&mut r, seq);
    r
}

/// The real PSW1 archive and typed index (`findex::WideFindex`: an
/// append-only archive plus a dedicated SQLite index) and the keeper's
/// observation (`WideObserver` + `WideFollow` + `ProofStore`) over the
/// **same literal records**, through the same typed decode, agree on the
/// full identities, the chain heads and the open march — and the hint they
/// both imply plans one snapshot-backed, unsigned, denied candidate.
/// Reconstruction from the archive, duplicates, a lost response, a
/// malformed body, a gap, a chain-broken record and the unknown source are
/// refused or stated on both sides. Nothing here is live or complete: the
/// source is a labelled fixture; no signature is verified.
#[test]
fn archive_index_and_keeper_observation_agree_on_literal_records() {
    let dir = parity_dir("store");
    let mut c = Chains::default();
    // The raw feed's sequence is the chain's global order filtered to this
    // program: the fixture's three records carry 10, 20 and 30. The archive
    // renumbers what it stores 1, 2, 3; the index is contiguous over those.
    let raw: Vec<TxRecord> = [10u64, 20, 30].iter().map(|&s| c.depart_at(s)).collect();
    // 1. The dedicated store ingests the fixture rows: archived first, then
    //    indexed with the chains verified from zero.
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let mut rows = Rows {
        rows: raw.clone(),
        after: 0,
        pulls: 0,
        fail_next: false,
    };
    let stored = block_on(store.ingest(&mut rows)).unwrap();
    store.commit().unwrap();
    assert_eq!(stored.len(), 3);
    assert_eq!(
        stored.iter().map(|r| r.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "the archive's own contiguous numbering"
    );
    assert_eq!(rows.after, 30, "the source's cursor is the raw sequence");
    assert_eq!(store.archive().cursor()["after"], 30);
    assert_eq!(store.archive().last_seq(), 3);
    // The archived records are the raw ones, renumbered: same slots,
    // signatures, wires and logs.
    for (a, r) in stored.iter().zip(raw.iter()) {
        assert_eq!(
            (a.slot, a.signature, &a.tx, &a.logs),
            (r.slot, r.signature, &r.tx, &r.logs)
        );
    }
    let recs = stored.clone();
    let st = store.index.status().unwrap();
    assert_eq!((st.last_seq, st.caught_up, st.blocked), (3, true, None));
    assert_eq!(st.source_coverage, "unknown");
    assert_eq!(st.capture_verification, "unverified");
    let page = store.index.events(0, 10).unwrap();
    assert_eq!(page.events.len(), 3);
    assert_eq!(page.source_coverage, "unknown");
    for (i, ev) in page.events.iter().enumerate() {
        assert_eq!(ev.format, "PSW1");
        assert_eq!(ev.archive_seq, i as u64 + 1);
        assert_eq!(
            ev.province,
            Some(home().to_bytes().to_vec()),
            "full province key"
        );
        assert_eq!(
            ev.holding,
            Some(host().holding_ref().to_bytes().to_vec()),
            "full holding reference"
        );
        assert_eq!(
            ev.host,
            Some(host().to_bytes().to_vec()),
            "full host reference"
        );
    }
    let idx_province = store
        .index
        .chain(WideTarget::Province(home()))
        .unwrap()
        .unwrap();
    let idx_holding = store
        .index
        .chain(WideTarget::Holding(host()))
        .unwrap()
        .unwrap();
    assert_eq!((idx_province.seq, idx_holding.seq), (3, 3));
    assert!(!idx_province.terminal);
    // 2. Reopen: the index catches up from the durable archive; the source
    //    resumes at the archived cursor. Then reconstruct: the SQLite file
    //    removed, the index is rebuilt from the archive alone, identical.
    drop(store);
    let store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    rows.after = 0;
    store.resume(&mut rows);
    assert_eq!(
        rows.after, 30,
        "the archived source cursor (raw sequence), not the archive's row count"
    );
    assert_eq!(store.index.status().unwrap().last_seq, 3);
    assert_eq!(
        store.index.events(0, 10).unwrap().next,
        3,
        "the event page cursor is an event number, a third numbering"
    );
    drop(store);
    std::fs::remove_file(dir.join("wide-index.sqlite")).unwrap();
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let st = store.index.status().unwrap();
    assert_eq!((st.last_seq, st.caught_up), (3, true));
    let rebuilt = store
        .index
        .chain(WideTarget::Province(home()))
        .unwrap()
        .unwrap();
    assert_eq!(rebuilt, idx_province, "rebuilt from the archive alone");
    // 3. The keeper's observation from the archive's own records (what a
    //    follower would pull after the legacy gate): the same typed
    //    decode, the chains verified link by link.
    let archived = store.archive().read_after(0).unwrap();
    assert_eq!(archived.len(), 3);
    for (a, r) in archived.iter().zip(recs.iter()) {
        assert_eq!(
            (a.seq, a.slot, a.signature, &a.tx, &a.logs),
            (r.seq, r.slot, r.signature, &r.tx, &r.logs)
        );
    }
    let port = FeedPort::new(archived, 2);
    let mut o = follow_observer();
    let mut proofs = ProofStore::default();
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut proofs), &scope(), false)),
        2,
        "pages [1, 2] and [3]"
    );
    assert_eq!(
        block_on(f.step(&port, &mut o, Some(&mut proofs), &scope(), false)),
        1,
        "the empty page: caught up to the archive"
    );
    assert!(f.caught_up);
    assert_eq!((f.cursor().0, o.last_seq_seen), (3, Some(3)));
    assert_eq!(f.sequence_holes, 0, "the archive's rows are contiguous");
    assert_eq!(
        (
            o.wide_txs,
            o.chain_anchored_from_genesis,
            o.chain_anchored_unverified,
            o.chain_verified
        ),
        (3, 2, 0, 4)
    );
    assert!(o.model.blocked().is_none());
    let obs_province = o.chain(WideTarget::Province(home())).unwrap();
    let obs_holding = o.chain(WideTarget::Holding(host())).unwrap();
    assert!(
        obs_province.from_genesis && obs_holding.from_genesis,
        "verified from the zero head: the equivalence below is earned, not assumed"
    );
    assert_eq!(
        (obs_province.seq, obs_province.head, obs_province.terminal),
        (idx_province.seq, idx_province.head, idx_province.terminal),
        "the province chain head: observer == typed index"
    );
    assert_eq!(
        (obs_holding.seq, obs_holding.head, obs_holding.terminal),
        (idx_holding.seq, idx_holding.head, idx_holding.terminal),
        "the holding chain head: observer == typed index"
    );
    // 3b. The same records as the raw feed serves them (10, 20, 30): the
    //     follower reports the skipped numbers as ranges it cannot judge,
    //     stops nowhere, and the observer reaches the same heads — chains
    //     bind records, not sequence numbers.
    let raw_port = FeedPort::new(raw.clone(), 10);
    let mut o_raw = follow_observer();
    let mut f_raw = WideFollow::from_observer(&o_raw);
    assert_eq!(
        block_on(f_raw.step(&raw_port, &mut o_raw, None, &scope(), false)),
        2
    );
    assert!(f_raw.stopped().is_none());
    assert_eq!((f_raw.cursor().0, o_raw.last_seq_seen), (30, Some(30)));
    assert_eq!(
        f_raw.sequence_holes, 27,
        "9 before 10, 9 between 10 and 20, 9 between 20 and 30"
    );
    assert_eq!(
        o_raw.gaps, 2,
        "the observer counts the discontinuities it saw"
    );
    assert_eq!(f_raw.status()["sequence_holes_unknown"], 27);
    let raw_head = o_raw.chain(WideTarget::Province(home())).unwrap();
    assert_eq!(
        (raw_head.seq, raw_head.head, raw_head.from_genesis),
        (obs_province.seq, obs_province.head, true)
    );
    // 3c. A follower that joins mid-history (its first record is the
    //     second departure) anchors on trust and says so: the heads match
    //     the index's numbers, but no from-genesis equivalence is claimed.
    let mid_port = FeedPort::new(raw[1..].to_vec(), 10);
    let mut o_mid = follow_observer();
    let mut f_mid = WideFollow::new(Some(10));
    assert_eq!(
        block_on(f_mid.step(&mid_port, &mut o_mid, None, &scope(), false)),
        2
    );
    let mid_head = o_mid.chain(WideTarget::Province(home())).unwrap();
    assert_eq!(
        (mid_head.seq, mid_head.head),
        (idx_province.seq, idx_province.head)
    );
    assert!(
        !mid_head.from_genesis,
        "anchored on trust: unverified prefix"
    );
    assert_eq!(
        (
            o_mid.chain_anchored_from_genesis,
            o_mid.chain_anchored_unverified,
            o_mid.chain_verified
        ),
        (0, 2, 2)
    );
    assert_eq!(o_mid.status()["chain"]["anchored_unverified"], 2);
    // 4. The hint both imply: the march of record 3 is open and unsettled;
    //    the extracted proof is record 3's; the reveal hint stands too.
    assert_eq!(wideduty::settle_candidates(&o.model), vec![(host(), SLOT)]);
    let proof = proofs
        .get(host(), SLOT)
        .expect("extracted from the archive's record")
        .proof
        .clone();
    assert_eq!(proof.provenance.seq, 3);
    assert_eq!(proof.provenance.method, METHOD_FEED);
    assert!(!proof.provenance.signatures_verified);
    assert_eq!(
        proofs_for(&o.model, std::slice::from_ref(&proof)),
        vec![proof]
    );
    // 5. One snapshot-backed, unsigned plan from that hint over literal
    //    accounts: coherent at the response's context slot, every hard
    //    denial kept, nothing enqueued.
    let fx = SettleFx::new(home());
    let mut accounts = fx.reads().accounts;
    let mut keys: Vec<Address> = accounts.keys().copied().collect();
    keys.push(actor());
    accounts.insert(
        actor(),
        Some(Account {
            lamports: 1_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let snap = snapshot_of(&accounts, &keys, clock_at(GENESIS_TS), 7);
    let reads = snap.reads();
    let cand = done(wideduty::plan_settle_departure(
        &dscope(),
        actor(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert!(cand.coherent() && !cand.signed && !cand.automatic_send);
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let view = EngineView::of(&engine, &widereview::Subject::of_duty(&cand));
    let a = widereview::review_candidate(&cand, &reads, &view);
    assert!(!a.review.admitted);
    for d in [
        Deny::SourceUnproven,
        Deny::HistoryUnknown,
        Deny::ExecutionEvidenceUnverified,
        Deny::SignerAbsent,
        Deny::SliceDoesNotEnqueue,
        Deny::SnapshotCurrencyUnknown,
    ] {
        assert!(a.review.denials.contains(&d), "{d:?}");
    }
    assert!(!a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(!a.review.denials.contains(&Deny::FundingUnknown));
    assert_eq!(engine.pending_len(), 0);
    // 6. The unknown source, said on every side.
    assert_eq!(o.status()["source_complete"], false);
    assert_eq!(f.status()["history_authenticated"], false);
    assert_eq!(store.index.status().unwrap().source_coverage, "unknown");
    // 7. A lost response: the store reports the port error, is not
    //    poisoned, and the archive stands; the next pull proceeds.
    rows.fail_next = true;
    let r = block_on(store.ingest(&mut rows));
    assert!(matches!(r, Err(findex::IngestError::Port(_))));
    assert!(!store.is_poisoned());
    assert_eq!(store.archive().last_seq(), 3);
    assert!(block_on(store.ingest(&mut rows)).unwrap().is_empty());
    drop(store);
    std::fs::remove_dir_all(&dir).unwrap();
    // 8. Refusals on both sides, each on a fresh index and observer.
    let fresh_index = |tag: &str| {
        let p = parity_dir(tag);
        (WideIndex::open(&p, program(), world()).unwrap(), p)
    };
    // (a) The same record again: the index refuses (sequence replay) and
    //     blocks; the observer treats an exact replay as a no-op; the
    //     follower, which pulls alone, refuses the page before the
    //     observer (`page-order`).
    let (mut idx, p) = fresh_index("dup");
    idx.add(&recs[0..2]).unwrap();
    assert!(idx.add(&[recs[1].clone()]).is_err());
    assert!(idx.status().unwrap().blocked.is_some());
    assert_eq!(idx.status().unwrap().last_seq, 2);
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&recs[0..2], &program()), 2);
    assert_eq!(o.observe_page(&recs[1..2], &program()), 0);
    assert_eq!(
        (o.accepted_prefix, o.wide_txs),
        (1, 2),
        "an exact replay: a no-op"
    );
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(
        block_on(f.step(
            &LiteralFeed(recs[1..2].to_vec()),
            &mut o,
            None,
            &scope(),
            false
        )),
        1
    );
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_PAGE_ORDER, 2))
    );
    // (b) The same sequence with other content: the index refuses; the
    //     observer blocks on the conflicting replay (fingerprints).
    let (mut idx, p) = fresh_index("conflict");
    idx.add(&recs[0..1]).unwrap();
    let mut conflict = recs[1].clone();
    conflict.seq = 1;
    assert!(idx.add(&[conflict.clone()]).is_err());
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&recs[0..1], &program()), 1);
    assert_eq!(o.observe_page(&[conflict], &program()), 0);
    assert!(o.model.blocked().unwrap().reason.contains("conflicting"));
    // (c) A malformed PSW1 body: the typed reader refuses it on both sides;
    //     the follower stops at the observer's block.
    let (mut idx, p) = fresh_index("malformed");
    assert!(idx.add(&[malformed_at(1)]).is_err());
    assert_eq!(idx.status().unwrap().last_seq, 0);
    assert!(idx.status().unwrap().blocked.is_some());
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(
        block_on(f.step(
            &LiteralFeed(vec![malformed_at(1)]),
            &mut o,
            None,
            &scope(),
            false
        )),
        1
    );
    assert_eq!(o.decode_failures, 1);
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 1))
    );
    assert_eq!(f.cursor().0, 0);
    // (d) A gap in the **archive's** numbering: the typed index refuses it
    //     (its rows are contiguous by construction). The raw-feed follower
    //     cannot judge a skipped number (above); but a record whose chain
    //     link does not continue the previous head — which is what a
    //     genuinely missing program record leaves behind — blocks the
    //     observer, and the follower stops there.
    let (mut idx, p) = fresh_index("gap");
    idx.add(&recs[0..1]).unwrap();
    assert!(idx.add(&recs[2..3]).is_err());
    assert_eq!(idx.status().unwrap().last_seq, 1);
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&recs[0..1], &program()), 1);
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(
        block_on(f.step(
            &LiteralFeed(recs[2..3].to_vec()),
            &mut o,
            None,
            &scope(),
            false
        )),
        1
    );
    assert_eq!(f.sequence_holes, 1, "the skipped number is reported");
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 3)),
        "the third record's links do not continue the first's heads"
    );
    assert!(o.model.blocked().unwrap().reason.contains("chain"));
    assert_eq!(o.last_seq_seen, Some(1));
    assert_eq!(f.cursor().0, 1);
    // (e) A chain-broken record (the second record's link head altered by
    //     one bit): the index rolls the batch back and blocks; the observer
    //     — which before this slice accepted any link tail — blocks at the
    //     same record with the same reason, the first record applied, the
    //     heads at 1; the follower stops there.
    let mut c2 = Chains::default();
    let b1 = c2.departed();
    let mut b2 = c2.departed();
    *b2.last_mut().unwrap() ^= 1;
    let r1 = c2.depart_record_with(1, b1);
    let r2 = c2.depart_record_with(2, b2);
    let (mut idx, p) = fresh_index("chain");
    assert!(idx.add(&[r1.clone(), r2.clone()]).is_err());
    let st = idx.status().unwrap();
    assert_eq!(st.last_seq, 0, "the whole batch rolled back");
    assert!(st.blocked.as_deref().unwrap().contains("chain"));
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[r1.clone(), r2.clone()], &program()), 1);
    assert_eq!(o.accepted_prefix, 1);
    let b = o.model.blocked().expect("blocked at the broken link");
    assert_eq!(b.seq, 2);
    assert!(b.reason.contains("chain") && b.reason.contains("mismatch"));
    assert_eq!(o.chain(WideTarget::Province(home())).unwrap().seq, 1);
    assert_eq!(o.chain(WideTarget::Holding(host())).unwrap().seq, 1);
    assert!(o.model.hosts.contains_key(&host()), "record 1 applied");
    let mut o = follow_observer();
    let mut f = WideFollow::from_observer(&o);
    assert_eq!(
        block_on(f.step(&LiteralFeed(vec![r1, r2]), &mut o, None, &scope(), false)),
        1
    );
    assert_eq!(
        f.stopped().map(|s| (s.code, s.seq)),
        Some((STOP_OBSERVER_BLOCKED, 2))
    );
    assert_eq!(f.cursor().0, 1);
    // (f) A province closed is terminal on both sides: a later record of
    //     that province is refused.
    let mut c3 = Chains::default();
    let d1 = c3.departed();
    let closed = c3.body(
        WideKind::ProvinceClosed,
        DEPART_BELL + 1,
        &home().to_bytes(),
        &wev::province_closed_payload(&[0xd5; 32], 5),
    );
    let after_close = c3.departed();
    let t1 = c3.depart_record_with(1, d1);
    let t2 = c3.depart_record_with(2, closed);
    let t3 = c3.depart_record_with(3, after_close);
    let (mut idx, p) = fresh_index("terminal");
    idx.add(&[t1.clone(), t2.clone()]).unwrap();
    assert!(idx.add(std::slice::from_ref(&t3)).is_err());
    assert!(idx
        .status()
        .unwrap()
        .blocked
        .as_deref()
        .unwrap()
        .contains("ProvinceClosed"));
    drop(idx);
    std::fs::remove_file(p).unwrap();
    let mut o = follow_observer();
    assert_eq!(o.observe_page(&[t1, t2], &program()), 2);
    assert!(o.chain(WideTarget::Province(home())).unwrap().terminal);
    assert_eq!(o.observe_page(&[t3], &program()), 0);
    assert!(o.model.blocked().unwrap().reason.contains("ProvinceClosed"));
}

/// A port whose account reads fail (the clock is served).
struct FailingPort;

impl ChainPort for FailingPort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(ClockSysvar {
            slot: 9,
            unix_timestamp: 1_790_444_847,
            ..ClockSysvar::default()
        })
    }
    async fn accounts(
        &self,
        _keys: &[Address],
        _min_slot: u64,
    ) -> PortResult<Vec<Option<Account>>> {
        Err(PortError::Io("the fixture RPC is down".into()))
    }
    async fn simulate(&self, _tx: &[u8]) -> PortResult<SimResult> {
        panic!("simulate must never be called")
    }
    async fn send(&self, _tx: &[u8]) -> PortResult<Signature> {
        panic!("send must never be called")
    }
    async fn statuses(&self, _sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(vec![])
    }
    async fn feed(&self, _after: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::default(), 0))
    }
}

#[test]
fn candidates_come_from_the_discovery_model_as_hints_only() {
    let mut d = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    assert!(wideduty::settle_candidates(&d).is_empty());
    assert!(wideduty::return_candidates(&d).is_empty());
    d.apply(&WideBatch {
        seq: 1,
        slot: 1_001,
        signature: "sig-1".into(),
        bodies: vec![departed_ok(home())],
    })
    .unwrap();
    assert_eq!(wideduty::settle_candidates(&d), vec![(host(), SLOT)]);
    // Settled: no longer a settle hint.
    d.apply(&WideBatch {
        seq: 2,
        slot: 1_002,
        signature: "sig-2".into(),
        bodies: vec![both(
            WideKind::DepartureSettled,
            DEPART_BELL + 1,
            &wev::host_key(&host(), home()),
            &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
        )],
    })
    .unwrap();
    assert!(wideduty::settle_candidates(&d).is_empty());
    // A Dissolve of another host of the same holding: a return hint for
    // (standing, holding reference).
    d.apply(&WideBatch {
        seq: 3,
        slot: 1_003,
        signature: "sig-3".into(),
        bodies: vec![both(
            WideKind::Dissolve,
            8,
            &wev::host_key(&host_b(), away()),
            &wev::dissolve_payload(8, TROOPS, 5),
        )],
    })
    .unwrap();
    assert_eq!(
        wideduty::return_candidates(&d),
        vec![(away(), host().holding_ref())]
    );
}

// ------------------------------------------------------------ gather fixture

/// `A` of THE anchor of `(ARRIVE_BELL, region 0)`: seven seconds into the
/// bell (a literal; the handler reads `a` and checks nothing about it).
const A_TS: i64 = GENESIS_TS + 600 * ARRIVE_BELL as i64 + 7;
/// The fixture provinces' stored region (`province_bytes` writes 0).
const REGION: u8 = 0;

/// The reveal close of `ARRIVE_BELL` under the fixture Season for an
/// anchor at `a`: the Season's own clock rule, nothing assumed about it.
fn close_for(a: i64) -> i64 {
    SeasonClock::from_season(&Season::decode(&season_ok()).unwrap()).reveal_close(ARRIVE_BELL, a)
}
fn gather_close() -> i64 {
    close_for(A_TS)
}
fn clock_ts(slot: u64, ts: i64) -> ClockSysvar {
    ClockSysvar {
        slot,
        unix_timestamp: ts,
        ..ClockSysvar::default()
    }
}
fn anchor_addr(bell: u32, region: u8) -> Address {
    addr(ctx().bell_anchor(bell, region))
}
fn archive_addr(bell: u32, region: u8) -> Address {
    addr(ctx().anchor_archive(region, archive_part_of(bell)))
}
fn inputs_addr(dest: ProvinceKey, bell: u32) -> Address {
    addr(wa::clash_inputs_address(&ctx(), dest, bell))
}
fn day_addr(dest: ProvinceKey, bell: u32) -> Address {
    addr(wa::arrival_day_address(&ctx(), dest, wa::day_of(bell)))
}
fn slot_addr(dest: ProvinceKey, bell: u32, k: u8) -> Address {
    addr(wa::arrival_slot_address(&ctx(), dest, bell, k / 4, k % 4))
}
fn host_transit_addr(slot: u8) -> Address {
    transit_addr(holding_addr(home().coord(), SITE), slot)
}

fn anchor_bytes(bell: u32, region: u8, a: i64, round: u64) -> Vec<u8> {
    let mut d = vec![0u8; BA::SIZE];
    assert!(wr_arr(&mut d, BA::HDR_MAGIC, &BA::MAGIC));
    assert!(wr_u64(&mut d, BA::SEASON_ID, SEASON_ID));
    assert!(wr_u32(&mut d, BA::BELL, bell));
    assert!(wr_u8(&mut d, BA::REGION, region));
    assert!(wr_u64(&mut d, BA::ROUND, round));
    assert!(wr_arr(&mut d, BA::A, &a.to_le_bytes()));
    d
}
/// The archive of `(region, part of bell)`; with `a_off`, holding `bell`
/// (its archived bit set, its entry's offset past the bell's end).
fn archive_bytes(bell: u32, region: u8, a_off: Option<u32>) -> Vec<u8> {
    let mut d = vec![0u8; AA::SIZE];
    assert!(wr_arr(&mut d, AA::HDR_MAGIC, &AA::MAGIC));
    assert!(wr_u64(&mut d, AA::SEASON_ID, SEASON_ID));
    assert!(wr_u8(&mut d, AA::REGION, region));
    assert!(wr_u32(&mut d, AA::PART, archive_part_of(bell)));
    if let Some(off) = a_off {
        let (at, mask) = AA::bit(AA::ARCHIVED, bell);
        d[at] |= mask;
        assert!(wr_u32(&mut d, AA::entry(bell) + AE::A_OFF, off));
    }
    d
}
/// The doctrine multiplier the reveal writes into a slot for a faction-0
/// host holding (`doctrine.dealt_bps(Hold, arrival)`, `proc/wide.rs::
/// reveal`): the kernel requires it in `[BPS_ONE, COMBAT_MAX_BPS]`
/// (`BadMultiplier` otherwise). The actual rule's value, not a literal.
fn arrival_dealt_bps() -> u16 {
    u16::try_from(
        of_faction_v3(0)
            .unwrap()
            .dealt_bps(Posture::Stance(Stance::Hold), true),
    )
    .unwrap()
}
fn gather_slot_bytes(
    dest: ProvinceKey,
    bell: u32,
    k: u8,
    h: WideHostRef,
    transit_slot: u8,
) -> Vec<u8> {
    let s = wa::WideArrivalSlot {
        season_id: SEASON_ID,
        dest,
        bell,
        faction: k / 4,
        i: k % 4,
        transit_slot,
        host: h,
        citizen: citizen(),
        unit: 2,
        stance: 0,
        tile: 1,
        retreat_bps: 0,
        dealt_bps: arrival_dealt_bps(),
        dep_mass: TROOPS,
        flags: 0,
        beneficiary: [0xB2; 32],
        rent_to: [0xB3; 32],
        ev_slot: 0,
        ev_price: 0,
        ev_limit: 0,
        ev_loaded: 0,
        claimed: false,
    };
    let mut d = vec![0u8; wa::wide_arrival_slot::SIZE];
    s.write(&mut d).unwrap();
    d
}
fn gather_day_bytes(dest: ProvinceKey, bell: u32, bit_set: bool) -> Vec<u8> {
    let mut rec = wa::WideArrivalDay::new(SEASON_ID, dest, wa::day_of(bell), [0xB4; 32]);
    if bit_set {
        assert!(rec.set(bell));
    }
    let mut d = vec![0u8; wa::wide_arrival_day::SIZE];
    rec.write(&mut d).unwrap();
    d
}
/// A ClashInputs of `(dest, bell)` with `mask` gathered, `flags`, and a
/// present arrival stored at each of `present` (position, host).
fn inputs_bytes(
    dest: ProvinceKey,
    bell: u32,
    mask: u32,
    flags: u8,
    present: &[(u8, WideHostRef)],
) -> Vec<u8> {
    let mut h = wa::WideClashInputsHdr::new(SEASON_ID, dest, bell, [0xB5; 32]);
    h.arrivals_mask = mask;
    h.flags = flags;
    h.n_present = present.len() as u8;
    let mut d = vec![0u8; wa::wide_clash_inputs::SIZE];
    h.write(&mut d).unwrap();
    for (k, host) in present {
        let a = wa::WideArrival {
            host: *host,
            citizen: citizen(),
            dep_mass: TROOPS,
            troops: TROOPS,
            stamina: 61,
            retreat_bps: 0,
            dealt_bps: arrival_dealt_bps(),
            faction: k / 4,
            unit: 2,
            tile: 1,
            stance: 0,
            present: true,
            fate: wa::wide_arrival::FATE_NONE,
            troops_after: 0,
        };
        a.write_at(&mut d, *k as usize).unwrap();
    }
    d
}

/// Every account a WideGather of `(away(), ARRIVE_BELL)` reads, as it would
/// be when the bell is gatherable: THE anchor present at `A_TS`, the window
/// closed by the clock, no ClashInputs yet, the ArrivalDay's bit set, the
/// slot of position 0 held by `host()` whose transit (slot `SLOT`) is
/// settled at the origin, every other slot absent.
struct GatherFx {
    season: Vec<u8>,
    province: Option<Vec<u8>>,
    anchor: Option<Vec<u8>>,
    archive: Option<Vec<u8>>,
    inputs: Option<Vec<u8>>,
    day: Option<Vec<u8>>,
    /// Present slots by position.
    slots: BTreeMap<u8, Option<Account>>,
    /// Transit records by address (every present slot's host's).
    transits: BTreeMap<Address, Option<Account>>,
    clock: Option<ClockSysvar>,
}
impl GatherFx {
    fn new() -> GatherFx {
        let mut slots = BTreeMap::new();
        slots.insert(
            0,
            acct(gather_slot_bytes(away(), ARRIVE_BELL, 0, host(), SLOT)),
        );
        let mut transits = BTreeMap::new();
        transits.insert(
            host_transit_addr(SLOT),
            acct(transit_bytes(host(), home(), true, root())),
        );
        GatherFx {
            season: season_ok(),
            province: Some(province_bytes(away(), ARRIVE_BELL)),
            anchor: Some(anchor_bytes(ARRIVE_BELL, REGION, A_TS, 1)),
            archive: None,
            inputs: None,
            day: Some(gather_day_bytes(away(), ARRIVE_BELL, true)),
            slots,
            transits,
            clock: Some(clock_ts(900, gather_close())),
        }
    }
    fn accounts(&self) -> BTreeMap<Address, Option<Account>> {
        let mut m = BTreeMap::new();
        m.insert(season_pda().0, acct(self.season.clone()));
        m.insert(province_addr(away()), self.province.clone().and_then(acct));
        m.insert(
            anchor_addr(ARRIVE_BELL, REGION),
            self.anchor.clone().and_then(acct),
        );
        m.insert(
            archive_addr(ARRIVE_BELL, REGION),
            self.archive.clone().and_then(acct),
        );
        m.insert(
            inputs_addr(away(), ARRIVE_BELL),
            self.inputs.clone().and_then(acct),
        );
        m.insert(
            day_addr(away(), ARRIVE_BELL),
            self.day.clone().and_then(acct),
        );
        for k in 0..wideduty::GATHER_POSITIONS {
            m.insert(
                slot_addr(away(), ARRIVE_BELL, k),
                self.slots.get(&k).cloned().flatten(),
            );
        }
        for (a, t) in &self.transits {
            m.insert(*a, t.clone());
        }
        m
    }
    fn reads(&self) -> Reads {
        let mut r = Reads::new(0);
        r.accounts = self.accounts();
        r.clock = self.clock;
        r
    }
    fn plan(&self) -> Result<Candidate, Block> {
        done(wideduty::plan_gather(
            &dscope(),
            payer(),
            away(),
            ARRIVE_BELL,
            &self.reads(),
        ))
    }
}

fn gather_facts(c: &Candidate) -> &wideduty::GatherFacts {
    match &c.duty {
        Duty::Gather(f) => f,
        other => panic!("not a gather: {other:?}"),
    }
}

/// The happy path: the handler's eight fixed accounts in its roles, one
/// `[slot r] [transit r|w]` pair per position of the cursor, the cursor as
/// long as one packet carries (one more pair would not fit), the data the
/// ABI's `Gather`, the present slot's transit stamped (writable), every
/// absent slot's transit position the slot's own read-only address, the
/// predictions from the transit record, the fee review naming the record
/// the handler creates; the same from the archive entry when THE anchor is
/// gone.
#[test]
fn a_gather_candidate_carries_the_handlers_accounts_cursor_and_predictions() {
    let fx = GatherFx::new();
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!(
        (f.dest, f.bell, f.region, f.resolved_next, f.start),
        (away(), ARRIVE_BELL, REGION, ARRIVE_BELL, 0)
    );
    assert!(!f.inputs_present && f.arrivals_mask_before == 0);
    assert!(f.day_bit_set && f.cut_at_unsettled.is_none());
    assert_eq!(f.inputs_prefunded_lamports, 0);
    // The cursor is bounded before any slot is read: the fixed maximum,
    // never the whole run of 24.
    let n = f.n as usize;
    assert_eq!(n, wideduty::GATHER_MAX_POSITIONS);
    assert!(wideduty::packet_len(&c.instruction, &payer()) <= wideduty::GATHER_PACKET_BYTES);
    // The test's own unsigned wire under the fixture budget fits too.
    assert!(wire_of(std::slice::from_ref(&c.instruction)).len() <= MAX_RECORD_WIRE_BYTES);
    // Every position of a full cursor present (eight hosts of eight
    // holdings, each with its own transit record): still one packet, even
    // with the all-zero placeholder payer that the message cannot dedup
    // for a real wallet.
    let mut full = GatherFx::new();
    for k in 0..wideduty::GATHER_MAX_POSITIONS as u8 {
        let h = WideHostRef::new(home(), k, GEN, 20 + k as u32).unwrap();
        full.slots
            .insert(k, acct(gather_slot_bytes(away(), ARRIVE_BELL, k, h, 0)));
        full.transits.insert(
            transit_addr(holding_addr(home().coord(), k), 0),
            acct(transit_bytes(h, home(), true, root())),
        );
    }
    let cf = full.plan().unwrap();
    let ff = gather_facts(&cf);
    assert_eq!((ff.n as usize, ff.stamps as usize), (n, n));
    assert_eq!(cf.instruction.accounts.len(), 8 + 2 * n);
    assert!(
        wideduty::packet_len(&cf.instruction, &Address::default()) <= wideduty::GATHER_PACKET_BYTES
    );
    assert!(wideduty::packet_len(&cf.instruction, &payer()) <= wideduty::GATHER_PACKET_BYTES);
    assert!(wire_of(std::slice::from_ref(&cf.instruction)).len() <= MAX_RECORD_WIRE_BYTES);
    assert_eq!(ff.predicted_n_present as usize, n);
    // The fixed eight, the handler's roles.
    let a = &c.instruction.accounts;
    assert_eq!(a.len(), 8 + 2 * n);
    let fixed: Vec<(Address, bool, bool)> = a[..8]
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(
        fixed,
        vec![
            (payer(), true, true),
            (season_pda().0, false, false),
            (province_addr(away()), false, false),
            (anchor_addr(ARRIVE_BELL, REGION), false, false),
            (inputs_addr(away(), ARRIVE_BELL), false, true),
            (day_addr(away(), ARRIVE_BELL), false, false),
            (fclient::addr::instructions_sysvar(), false, false),
            (fclient::addr::system_program(), false, false),
        ]
    );
    // Pair 0: the present slot, then its host's transit, writable (stamped).
    assert_eq!(
        (a[8].pubkey, a[8].is_writable),
        (slot_addr(away(), ARRIVE_BELL, 0), false)
    );
    assert_eq!(
        (a[9].pubkey, a[9].is_signer, a[9].is_writable),
        (host_transit_addr(SLOT), false, true)
    );
    // Every other pair: the absent slot, then the slot's own address.
    for k in 1..n {
        let s = slot_addr(away(), ARRIVE_BELL, k as u8);
        assert_eq!((a[8 + 2 * k].pubkey, a[8 + 2 * k].is_writable), (s, false));
        assert_eq!((a[9 + 2 * k].pubkey, a[9 + 2 * k].is_writable), (s, false));
    }
    assert_eq!(
        c.instruction.data,
        Gather {
            bell: ARRIVE_BELL,
            start: 0,
            n: n as u8,
        }
        .to_bytes()
        .to_vec()
    );
    // The predictions, from the transit record.
    assert_eq!(f.positions.len(), n);
    let s0 = f.positions[0].slot.as_ref().unwrap();
    assert_eq!(
        (s0.host, s0.transit_slot, s0.transit_state, s0.stamps),
        (host(), SLOT, MarchState::Settled, true)
    );
    assert!(s0.predicted_present && !s0.predicted_destroyed);
    assert_eq!(s0.troops_milli, TROOPS);
    assert_eq!(
        s0.stamina,
        frontier_abi::clash_model::arrival_stamina(61, DEPART_BELL, ARRIVE_BELL)
    );
    assert!(f.positions[1..].iter().all(|p| p.slot.is_none()));
    assert_eq!(f.predicted_mask_after, (1u32 << n) - 1);
    assert_eq!(
        (
            f.predicted_n_present,
            f.stamps,
            f.predicted_complete,
            f.predicted_no_arrivals
        ),
        (1, 1, n == 24, false)
    );
    assert_eq!(f.remaining_after as usize, 24 - n);
    assert_eq!(
        (f.anchor_source, f.a_ts, f.reveal_close, f.judged_at),
        ("anchor", A_TS, gather_close(), gather_close())
    );
    assert!(!c.signed && !c.automatic_send && !c.coherent());
    let d = c.describe();
    assert_eq!(d["kind"], "WideGather");
    assert_eq!(d["facts"]["n"], n);
    assert_eq!(d["facts"]["start"], 0);
    // The fee review names the record the handler creates.
    let needs = widefees::duty_needs(&c, &fx.reads()).unwrap();
    assert_eq!(
        needs.creates,
        vec![("wide ClashInputs", wa::wide_clash_inputs::SIZE)]
    );
    // The archive entry in place of THE anchor: `A = bell end + a_off`.
    let mut arch = GatherFx::new();
    arch.anchor = None;
    arch.archive = Some(archive_bytes(ARRIVE_BELL, REGION, Some(5)));
    let a_arch = bell_end(GENESIS_TS, ARRIVE_BELL) + 5;
    arch.clock = Some(clock_ts(900, close_for(a_arch)));
    let c2 = arch.plan().unwrap();
    let f2 = gather_facts(&c2);
    assert_eq!(
        (f2.anchor_source, f2.a_ts, f2.reveal_close),
        ("archive", a_arch, close_for(a_arch))
    );
    assert_eq!(
        c2.instruction.accounts[3].pubkey,
        archive_addr(ARRIVE_BELL, REGION)
    );
    // One second before that close: open.
    arch.clock = Some(clock_ts(900, close_for(a_arch) - 1));
    assert_eq!(
        arch.plan().unwrap_err(),
        Block::WindowOpen {
            reveal_close: close_for(a_arch),
            now: close_for(a_arch) - 1
        }
    );
}

/// The live-read driver through a real read adapter: the gather asks in
/// four waves at the requested bound and decides at the fifth evaluation
/// — the same instruction the fixture's direct plan gives; nothing
/// simulated or sent.
#[test]
fn gather_via_reads_in_four_waves_through_the_port() {
    let fx = GatherFx::new();
    let port = ClockedPort::new(fx.accounts(), gather_close());
    let c = block_on(wideduty::gather_via(
        &port,
        &dscope(),
        payer(),
        away(),
        ARRIVE_BELL,
        777,
    ))
    .unwrap();
    assert_eq!(c.instruction, fx.plan().unwrap().instruction);
    assert_eq!(c.min_slot, 777);
    assert!(!c.coherent());
    assert_eq!(*port.min_slots.lock().unwrap(), vec![777, 777, 777, 777]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // No present slot: three waves.
    let mut empty = GatherFx::new();
    empty.slots.clear();
    let port = ClockedPort::new(empty.accounts(), gather_close());
    let c = block_on(wideduty::gather_via(
        &port,
        &dscope(),
        payer(),
        away(),
        ARRIVE_BELL,
        5,
    ))
    .unwrap();
    assert_eq!(gather_facts(&c).stamps, 0);
    assert_eq!(*port.min_slots.lock().unwrap(), vec![5, 5, 5]);
}

/// The cursor is bounded before any slot is judged: a present slot whose
/// transit is still `Departed` **beyond** the cursor does not touch the
/// first packet; one **inside** the cursor, after the first position, cuts
/// the cursor before it (the ready prefix is the gather); one **at** the
/// first position blocks.
#[test]
fn a_later_unsettled_position_never_blocks_the_first_ready_packet() {
    let max = wideduty::GATHER_MAX_POSITIONS as u8;
    // Beyond the cursor (position `max`): unread, irrelevant.
    let mut fx = GatherFx::new();
    let beyond = WideHostRef::new(home(), SITE, GEN, 9).unwrap();
    fx.slots.insert(
        max,
        acct(gather_slot_bytes(away(), ARRIVE_BELL, max, beyond, 2)),
    );
    fx.transits.insert(
        host_transit_addr(2),
        acct(transit_bytes(beyond, home(), false, root())),
    );
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!((f.start, f.n, f.cut_at_unsettled), (0, max, None));
    assert!(!c
        .instruction
        .accounts
        .iter()
        .any(|m| m.pubkey == host_transit_addr(2)));
    // Inside the cursor at position 3: the cursor is positions 0..3.
    let mut fx = GatherFx::new();
    let inside = WideHostRef::new(home(), SITE, GEN, 10).unwrap();
    fx.slots.insert(
        3,
        acct(gather_slot_bytes(away(), ARRIVE_BELL, 3, inside, 3)),
    );
    fx.transits.insert(
        host_transit_addr(3),
        acct(transit_bytes(inside, home(), false, root())),
    );
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!((f.start, f.n, f.cut_at_unsettled), (0, 3, Some(3)));
    assert_eq!(c.instruction.accounts.len(), 8 + 2 * 3);
    assert_eq!(f.predicted_mask_after, 0b111);
    assert_eq!(f.remaining_after, 21);
    assert_eq!(
        c.instruction.data,
        Gather {
            bell: ARRIVE_BELL,
            start: 0,
            n: 3,
        }
        .to_bytes()
        .to_vec()
    );
    assert!(!c
        .instruction
        .accounts
        .iter()
        .any(|m| m.pubkey == host_transit_addr(3)));
    // At the first position: blocked (nothing ready before it).
    let mut fx = GatherFx::new();
    fx.transits.insert(
        host_transit_addr(SLOT),
        acct(transit_bytes(host(), home(), false, root())),
    );
    assert_eq!(
        fx.plan().unwrap_err(),
        Block::DepartureUnsettled { position: 0 }
    );
}

/// The present count is the handler's scan of **every** position of the
/// written record: a present arrival stored at an unmasked position
/// outside the cursor counts; a position outside the cursor that does not
/// decode fails (`BadAccount`); one inside the cursor is overwritten and
/// does not.
#[test]
fn the_present_count_mirrors_the_handlers_scan_of_every_position() {
    // Positions 0 and 3 gathered → the cursor is 1..3; a present arrival
    // stored at 5 (unmasked, outside the cursor).
    let mut fx = GatherFx::new();
    fx.slots.clear();
    fx.inputs = Some(inputs_bytes(
        away(),
        ARRIVE_BELL,
        0b1001,
        0,
        &[(0, host()), (5, host_b())],
    ));
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!((f.start, f.n), (1, 2));
    assert_eq!(
        f.predicted_n_present, 2,
        "the masked one and the unmasked one"
    );
    // Garbage at position 7 (outside the cursor): the handler's scan fails.
    let mut bad = fx.inputs.clone().unwrap();
    let o = wa::wide_clash_inputs::arrival(7);
    bad[o..o + 8].copy_from_slice(&[0xFF; 8]);
    fx.inputs = Some(bad);
    assert_eq!(fx.plan().unwrap_err(), Block::Unreadable("inputs position"));
    // Garbage at position 1 (inside the cursor): zeroed and rewritten by
    // the handler; the plan stands.
    let mut fx = GatherFx::new();
    fx.slots.clear();
    let mut d = inputs_bytes(away(), ARRIVE_BELL, 0b1001, 0, &[]);
    let o = wa::wide_clash_inputs::arrival(1);
    d[o..o + 8].copy_from_slice(&[0xFF; 8]);
    fx.inputs = Some(d);
    let f = gather_facts(&fx.plan().unwrap()).clone();
    assert_eq!((f.start, f.n, f.predicted_n_present), (1, 2, 0));
}

/// The ArrivalDay's bit clear with a **partial** record: the handler
/// completes the mask without reading a slot (the resolve requires the
/// complete record), so the plan is the completing gather of one position
/// with its slot unread — a `Departed` transit behind that slot cannot
/// block it — nothing written to the positions, the present count from
/// the record as it is. With no record at all the plan is `NoArrivals`.
#[test]
fn a_clear_day_bit_with_a_partial_record_plans_the_completing_gather() {
    let mut fx = GatherFx::new();
    fx.day = Some(gather_day_bytes(away(), ARRIVE_BELL, false));
    fx.inputs = Some(inputs_bytes(away(), ARRIVE_BELL, 0b111, 0, &[(2, host())]));
    // A slot at the first ungathered position whose transit is unsettled:
    // never read.
    fx.slots.insert(
        3,
        acct(gather_slot_bytes(away(), ARRIVE_BELL, 3, host(), SLOT)),
    );
    fx.transits.insert(
        host_transit_addr(SLOT),
        acct(transit_bytes(host(), home(), false, root())),
    );
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert!(!f.day_bit_set);
    assert_eq!((f.start, f.n, f.stamps), (3, 1, 0));
    assert!(f.positions[0].slot.is_none(), "the slot is not read");
    assert_eq!(f.predicted_mask_after, wa::wide_clash_inputs::ALL_GATHERED);
    assert_eq!(
        (
            f.predicted_complete,
            f.predicted_n_present,
            f.predicted_no_arrivals,
            f.remaining_after
        ),
        (true, 1, false, 0)
    );
    let a = &c.instruction.accounts;
    assert_eq!(a.len(), 10);
    assert_eq!(a[8].pubkey, slot_addr(away(), ARRIVE_BELL, 3));
    assert_eq!(
        (a[9].pubkey, a[9].is_writable),
        (slot_addr(away(), ARRIVE_BELL, 3), false)
    );
    assert_eq!(
        c.instruction.data,
        Gather {
            bell: ARRIVE_BELL,
            start: 3,
            n: 1,
        }
        .to_bytes()
        .to_vec()
    );
    assert_eq!(c.describe()["facts"]["day_bit_set"], false);
    // The day absent with the same partial record: the same completing gather.
    fx.day = None;
    assert_eq!(gather_facts(&fx.plan().unwrap()).n, 1);
    // No record: not planned.
    fx.inputs = None;
    assert_eq!(fx.plan().unwrap_err(), Block::NoArrivals);
}

/// The gather handler has no full-minimum guard: `init_with_seed` tops the
/// ClashInputs address up from the payer by the shortfall over what it
/// already holds. The fee review nets a prefunded address: fully prefunded,
/// the payer needs the fee alone; a lamport short is unmet; an unfunded
/// address needs the full minimum plus the fee.
#[test]
fn a_prefunded_clash_inputs_leaves_the_payer_the_fee_alone() {
    let minimum = RENT_FIXTURE
        .minimum_balance(wa::wide_clash_inputs::SIZE)
        .unwrap();
    let wallet = |lamports: u64| {
        Some(Account {
            lamports,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        })
    };
    let fx = GatherFx::new();
    let needs_with = |inputs_lamports: Option<u64>, payer_lamports: u64| {
        let mut accounts = fx.accounts();
        accounts.insert(
            inputs_addr(away(), ARRIVE_BELL),
            inputs_lamports.and_then(wallet),
        );
        accounts.insert(payer(), wallet(payer_lamports));
        let keys: Vec<Address> = accounts.keys().copied().collect();
        let snap = snapshot_of_rent(&accounts, &keys, clock_ts(2_000, gather_close()), 7);
        let reads = snap.reads();
        let c = done(wideduty::plan_gather(
            &dscope(),
            payer(),
            away(),
            ARRIVE_BELL,
            &reads,
        ))
        .unwrap();
        assert!(c.coherent());
        let f = gather_facts(&c);
        assert!(!f.inputs_present);
        assert_eq!(f.inputs_prefunded_lamports, inputs_lamports.unwrap_or(0));
        widefees::duty_needs(&c, &reads).unwrap()
    };
    // Fully prefunded: the fee alone.
    let n = needs_with(Some(minimum), 5_000);
    assert_eq!(
        n.creates,
        vec![("wide ClashInputs", wa::wide_clash_inputs::SIZE)]
    );
    assert_eq!(n.rent_lamports, Known::Known(minimum));
    assert_eq!(n.prefunded_lamports, minimum);
    assert_eq!(n.rent_rule, widefees::RENT_RULE_TOP_UP);
    assert_eq!(n.required_lower_bound, Known::Known(5_000));
    assert_eq!(
        n.funding,
        Funding::MetLowerBound {
            payer_lamports: 5_000,
            required: 5_000
        }
    );
    assert_eq!(n.describe()["prefunded_lamports"], minimum);
    // A lamport short of the fee.
    let n = needs_with(Some(minimum), 4_999);
    assert_eq!(
        n.funding,
        Funding::Unmet {
            payer_lamports: 4_999,
            required: 5_000,
            short: 1
        }
    );
    // Half prefunded: the other half plus the fee.
    let n = needs_with(Some(minimum / 2), 5_000);
    assert_eq!(
        n.required_lower_bound,
        Known::Known(minimum - minimum / 2 + 5_000)
    );
    assert!(matches!(n.funding, Funding::Unmet { .. }));
    // Nothing at the address: the full minimum plus the fee.
    let n = needs_with(None, 5_000);
    assert_eq!(n.prefunded_lamports, 0);
    assert_eq!(n.required_lower_bound, Known::Known(minimum + 5_000));
    assert!(matches!(n.funding, Funding::Unmet { .. }));
}

/// Positions gathered before are not read again (duplicates): the cursor
/// starts after them, a stored present arrival counts in the prediction;
/// a gathered position inside the run cuts it; the last part completes
/// the record (`FLAG_NO_ARRIVALS` when nothing is present); a finished
/// record, a resolved record and another bell's record are refused.
#[test]
fn a_gather_resumes_after_the_gathered_positions_and_refuses_a_finished_or_resolved_record() {
    let mut fx = GatherFx::new();
    fx.inputs = Some(inputs_bytes(away(), ARRIVE_BELL, 1, 0, &[(0, host())]));
    // Position 2: another host of the same holding, its transit slot 0,
    // settled at the origin.
    fx.slots.insert(
        2,
        acct(gather_slot_bytes(away(), ARRIVE_BELL, 2, host_b(), 0)),
    );
    fx.transits.insert(
        host_transit_addr(0),
        acct(transit_bytes(host_b(), home(), true, root())),
    );
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!(
        (f.start, f.inputs_present, f.arrivals_mask_before),
        (1, true, 1)
    );
    assert!(
        f.positions.iter().all(|p| p.position >= 1),
        "position 0 is not read again"
    );
    assert!(f.positions[0].slot.is_none());
    let s2 = f.positions[1].slot.as_ref().unwrap();
    assert_eq!(
        (f.positions[1].position, s2.host, s2.transit_slot),
        (2, host_b(), 0)
    );
    assert_eq!(c.instruction.accounts[11].pubkey, host_transit_addr(0));
    assert!(c.instruction.accounts[11].is_writable);
    assert_eq!(
        f.predicted_n_present, 2,
        "the stored present arrival and the new one"
    );
    assert_eq!(f.stamps, 1);
    assert_eq!(f.predicted_mask_after & 1, 1);
    assert_eq!(
        c.instruction.data,
        Gather {
            bell: ARRIVE_BELL,
            start: 1,
            n: f.n,
        }
        .to_bytes()
        .to_vec()
    );
    assert!(
        widefees::duty_needs(&c, &fx.reads())
            .unwrap()
            .creates
            .is_empty(),
        "the record exists: nothing is created"
    );
    // A gathered position inside the run cuts the cursor: 0, 1, 2 and 4
    // gathered → position 3 alone.
    let mut split = GatherFx::new();
    split.slots.clear();
    split.inputs = Some(inputs_bytes(away(), ARRIVE_BELL, 0b1_0111, 0, &[]));
    let f = gather_facts(&split.plan().unwrap()).clone();
    assert_eq!((f.start, f.n, f.predicted_complete), (3, 1, false));
    // The last part: positions 0..21 gathered, nothing present anywhere.
    let mut last = GatherFx::new();
    last.slots.clear();
    last.inputs = Some(inputs_bytes(away(), ARRIVE_BELL, (1u32 << 21) - 1, 0, &[]));
    let c = last.plan().unwrap();
    let f = gather_facts(&c);
    assert_eq!(
        (
            f.start,
            f.n,
            f.predicted_mask_after,
            f.predicted_n_present,
            f.predicted_complete,
            f.predicted_no_arrivals,
            f.remaining_after
        ),
        (21, 3, wa::wide_clash_inputs::ALL_GATHERED, 0, true, true, 0)
    );
    assert_eq!(c.instruction.accounts.len(), 8 + 2 * 3);
    // Every position gathered: nothing to gather.
    let mut finished = GatherFx::new();
    finished.inputs = Some(inputs_bytes(
        away(),
        ARRIVE_BELL,
        wa::wide_clash_inputs::ALL_GATHERED,
        0,
        &[],
    ));
    assert_eq!(finished.plan().unwrap_err(), Block::AlreadyGathered);
    // Resolved: `AlreadyDone`.
    let mut resolved = GatherFx::new();
    resolved.inputs = Some(inputs_bytes(
        away(),
        ARRIVE_BELL,
        wa::wide_clash_inputs::ALL_GATHERED,
        wa::wide_clash_inputs::FLAG_RESOLVED,
        &[],
    ));
    assert_eq!(resolved.plan().unwrap_err(), Block::AlreadyResolved);
    // Another bell's record at the address.
    let mut other_bell = GatherFx::new();
    other_bell.inputs = Some(inputs_bytes(away(), ARRIVE_BELL + 1, 0, 0, &[]));
    assert_eq!(
        other_bell.plan().unwrap_err(),
        Block::NotCanonical("inputs")
    );
}

/// The handler's refusals, each from literal bytes: no arrival evidence
/// (the ArrivalDay absent or its bit clear — never "no arrivals" from the
/// feed), the latch, the end bell, the window by a second, no clock, no
/// anchor or an archive without the bell, another bell's anchor, a
/// departure not settled at the origin, a transit absent, another host's,
/// gathered elsewhere (and gathered here: taken as is, not stamped), a
/// slot of another destination, a slot owned by another program, the
/// destination absent, a legacy Province at the address, another world's
/// key.
#[test]
fn a_gather_blocks_on_the_handlers_refusals() {
    let blocked = |f: GatherFx| f.plan().unwrap_err();
    let mut fx = GatherFx::new();
    fx.day = None;
    assert_eq!(blocked(fx), Block::NoArrivals);
    let mut fx = GatherFx::new();
    fx.day = Some(gather_day_bytes(away(), ARRIVE_BELL, false));
    assert_eq!(blocked(fx), Block::NoArrivals);
    let mut fx = GatherFx::new();
    fx.day = Some(gather_day_bytes(home(), ARRIVE_BELL, true));
    assert_eq!(blocked(fx), Block::NotCanonical("arrivalday"));
    let mut fx = GatherFx::new();
    fx.province = Some(province_bytes(away(), ARRIVE_BELL + 1));
    assert_eq!(
        blocked(fx),
        Block::LatchClosed("destination resolved past the bell")
    );
    let mut fx = GatherFx::new();
    let mut ended = season_ok();
    assert!(wr_u32(&mut ended, SL::END_BELL, ARRIVE_BELL));
    fx.season = ended;
    assert_eq!(blocked(fx), Block::SeasonEnded);
    let mut fx = GatherFx::new();
    fx.clock = Some(clock_ts(900, gather_close() - 1));
    assert_eq!(
        blocked(fx),
        Block::WindowOpen {
            reveal_close: gather_close(),
            now: gather_close() - 1
        }
    );
    let mut fx = GatherFx::new();
    fx.clock = None;
    assert_eq!(blocked(fx), Block::TimingNeedsClock);
    let mut fx = GatherFx::new();
    fx.anchor = None;
    assert_eq!(blocked(fx), Block::NoAnchor("absent"));
    let mut fx = GatherFx::new();
    fx.anchor = None;
    fx.archive = Some(archive_bytes(ARRIVE_BELL, REGION, None));
    assert_eq!(blocked(fx), Block::NoAnchor("archive without the bell"));
    let mut fx = GatherFx::new();
    fx.anchor = Some(anchor_bytes(ARRIVE_BELL + 1, REGION, A_TS, 1));
    assert_eq!(blocked(fx), Block::NotCanonical("anchor"));
    // The transit record of the present slot.
    let mut fx = GatherFx::new();
    fx.transits.insert(
        host_transit_addr(SLOT),
        acct(transit_bytes(host(), home(), false, root())),
    );
    assert_eq!(blocked(fx), Block::DepartureUnsettled { position: 0 });
    let mut fx = GatherFx::new();
    fx.transits.insert(host_transit_addr(SLOT), None);
    assert_eq!(blocked(fx), Block::Absent("transit"));
    let mut fx = GatherFx::new();
    fx.transits.insert(
        host_transit_addr(SLOT),
        acct(transit_bytes(host_b(), home(), true, root())),
    );
    assert_eq!(blocked(fx), Block::NotCanonical("transit"));
    let settled = WideTransit::from_bytes(&transit_bytes(host(), home(), true, root())).unwrap();
    let mut fx = GatherFx::new();
    let elsewhere = settled
        .step(MarchEvent::Gather { dest: home() }, None)
        .unwrap();
    fx.transits
        .insert(host_transit_addr(SLOT), acct(elsewhere.to_bytes().to_vec()));
    assert_eq!(blocked(fx), Block::NotCanonical("transit"));
    let mut fx = GatherFx::new();
    let here = settled
        .step(MarchEvent::Gather { dest: away() }, None)
        .unwrap();
    fx.transits
        .insert(host_transit_addr(SLOT), acct(here.to_bytes().to_vec()));
    let c = fx.plan().unwrap();
    let f = gather_facts(&c);
    let s0 = f.positions[0].slot.as_ref().unwrap();
    assert_eq!(
        (s0.transit_state, s0.stamps, s0.predicted_present),
        (MarchState::Gathered, false, true)
    );
    assert_eq!(f.stamps, 0);
    assert!(
        !c.instruction.accounts[9].is_writable,
        "not stamped: read-only"
    );
    // The slot at the position's address.
    let mut fx = GatherFx::new();
    fx.slots.insert(
        0,
        acct(gather_slot_bytes(home(), ARRIVE_BELL, 0, host(), SLOT)),
    );
    assert_eq!(blocked(fx), Block::NotCanonical("slot"));
    let mut fx = GatherFx::new();
    let mut foreign = acct(gather_slot_bytes(away(), ARRIVE_BELL, 0, host(), SLOT)).unwrap();
    foreign.owner = actor();
    fx.slots.insert(0, Some(foreign));
    assert_eq!(blocked(fx), Block::ForeignOwner("slot"));
    // The destination.
    let mut fx = GatherFx::new();
    fx.province = None;
    assert_eq!(blocked(fx), Block::Absent("dest_province"));
    let mut fx = GatherFx::new();
    fx.province = Some(legacy_province_bytes());
    assert_eq!(blocked(fx), Block::Unreadable("dest_province"));
    let fx = GatherFx::new();
    assert_eq!(
        done(wideduty::plan_gather(
            &dscope(),
            payer(),
            ProvinceKey::new(other_world(), away().coord()),
            ARRIVE_BELL,
            &fx.reads()
        ))
        .unwrap_err(),
        Block::World
    );
}

/// A gather candidate planned over one snapshot is coherent and bound to
/// its content: another cursor claimed, a transit flag changed or a
/// prediction edited loses the snapshot, the fee bound and the review's
/// snapshot denial changes; every hard denial stands either way.
#[test]
fn a_gather_candidate_is_bound_to_its_snapshot_and_content() {
    let fx = GatherFx::new();
    let accounts = fx.accounts();
    let keys: Vec<Address> = accounts.keys().copied().collect();
    let snap = snapshot_of(&accounts, &keys, clock_ts(2_000, gather_close()), 7);
    let reads = snap.reads();
    let c = done(wideduty::plan_gather(
        &dscope(),
        payer(),
        away(),
        ARRIVE_BELL,
        &reads,
    ))
    .unwrap();
    assert!(c.coherent());
    assert_eq!(c.snapshot().map(|m| m.context_slot()), Some(2_000));
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let open = EngineView::of(&engine, &widereview::Subject::of_duty(&c));
    let a = widereview::review_candidate(&c, &reads, &open);
    assert!(!a.review.admitted);
    assert!(a.snapshot.is_some());
    for d in [
        Deny::SourceUnproven,
        Deny::HistoryUnknown,
        Deny::SignerAbsent,
        Deny::SliceDoesNotEnqueue,
    ] {
        assert!(a.review.denials.contains(&d), "{d:?}");
    }
    assert!(a.review.subject.key.starts_with("wide-gather:"));
    assert!(a.review.subject.key.ends_with(&format!(":{ARRIVE_BELL}:0")));
    let mut m = c.clone();
    if let Duty::Gather(f) = &mut m.duty {
        f.start = 1;
    }
    lost_everything("start", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[9].is_writable = false;
    lost_everything("transit flag", &m, &reads, &open);
    let mut m = c.clone();
    if let Duty::Gather(f) = &mut m.duty {
        f.predicted_no_arrivals = true;
    }
    lost_everything("no_arrivals", &m, &reads, &open);
    let mut m = c.clone();
    if let Duty::Gather(f) = &mut m.duty {
        f.positions[0].slot.as_mut().unwrap().stamps = false;
    }
    lost_everything("stamps", &m, &reads, &open);
}

/// Gather hints come from the model's revealed open marches, as read
/// hints only: a departure alone is none; a reveal with its arrival bell
/// in the applied history is one; a partial gather keeps it, a full gather
/// or a resolve of the bell drops it.
#[test]
fn gather_hints_come_from_revealed_open_marches_only() {
    let mut d = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    assert!(wideduty::gather_candidates(&d).is_empty());
    d.apply(&WideBatch {
        seq: 1,
        slot: 1_001,
        signature: "sig-1".into(),
        bodies: vec![departed_ok(home())],
    })
    .unwrap();
    assert!(
        wideduty::gather_candidates(&d).is_empty(),
        "departed, not revealed"
    );
    d.apply(&WideBatch {
        seq: 2,
        slot: 1_002,
        signature: "sig-2".into(),
        bodies: vec![encode(
            WideKind::Revealed,
            ARRIVE_BELL,
            &wev::host_key(&host(), away()),
            &wev::revealed_payload(SLOT, 0, 0, 33, 0, 0, TROOPS, false),
            &[],
        )
        .unwrap()],
    })
    .unwrap();
    assert_eq!(wideduty::gather_candidates(&d), vec![(away(), ARRIVE_BELL)]);
    let gathered = |mask: u32| {
        encode(
            WideKind::Gathered,
            ARRIVE_BELL + 1,
            &away().to_bytes(),
            &wev::gathered_payload(ARRIVE_BELL, 0, 8, mask, 1, false),
            &[],
        )
        .unwrap()
    };
    let mut partial = d.clone();
    partial
        .apply(&WideBatch {
            seq: 3,
            slot: 1_003,
            signature: "sig-3".into(),
            bodies: vec![gathered(0xFF)],
        })
        .unwrap();
    assert_eq!(
        wideduty::gather_candidates(&partial),
        vec![(away(), ARRIVE_BELL)],
        "a partial gather keeps the hint"
    );
    let mut full = d.clone();
    full.apply(&WideBatch {
        seq: 3,
        slot: 1_003,
        signature: "sig-3".into(),
        bodies: vec![gathered(wa::wide_clash_inputs::ALL_GATHERED)],
    })
    .unwrap();
    assert!(
        wideduty::gather_candidates(&full).is_empty(),
        "fully gathered"
    );
    let mut resolved = d.clone();
    resolved
        .apply(&WideBatch {
            seq: 3,
            slot: 1_003,
            signature: "sig-3".into(),
            bodies: vec![encode(
                WideKind::Resolve,
                ARRIVE_BELL,
                &away().to_bytes(),
                &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, false),
                &[link(WideEntity::Province, 1)],
            )
            .unwrap()],
        })
        .unwrap();
    assert!(
        wideduty::gather_candidates(&resolved).is_empty(),
        "resolved"
    );
}

/// The tick: a model with one revealed, origin-settled march lists one
/// gather hint and nothing else; the plan runs over one snapshot (with the
/// Rent: the record may be created), makes a coherent candidate, reviews
/// it with every hard denial, counts it, and enqueues nothing; with the
/// window still open at the tick's clock the hint is planned and blocked.
#[test]
fn the_tick_plans_a_gather_candidate_reviews_it_and_enqueues_nothing() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
    model
        .apply(&WideBatch {
            seq: 2,
            slot: 1_002,
            signature: "sig-2".into(),
            bodies: vec![both(
                WideKind::DepartureSettled,
                DEPART_BELL + 1,
                &wev::host_key(&host(), home()),
                &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
            )],
        })
        .unwrap();
    model
        .apply(&WideBatch {
            seq: 3,
            slot: 1_003,
            signature: "sig-3".into(),
            bodies: vec![encode(
                WideKind::Revealed,
                ARRIVE_BELL,
                &wev::host_key(&host(), away()),
                &wev::revealed_payload(SLOT, 0, 0, 33, 0, 0, TROOPS, false),
                &[],
            )
            .unwrap()],
        })
        .unwrap();
    assert!(wideduty::settle_candidates(&model).is_empty());
    assert!(wideduty::return_candidates(&model).is_empty());
    assert_eq!(
        wideduty::gather_candidates(&model),
        vec![(away(), ARRIVE_BELL)]
    );
    let fx = GatherFx::new();
    let port = ClockedPort::new(fx.accounts(), gather_close());
    let mut lit = LiteralSnapshots::new(fx.accounts());
    lit.clock_ts = gather_close();
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!(
        (
            review.plans,
            review.gather_plans,
            review.candidates,
            review.gather_candidates,
            review.coherent,
            review.blocked
        ),
        (1, 1, 1, 1, 1, 0)
    );
    // One snapshot request, holding the planner's keys.
    let keys = lit.keys.lock().unwrap().clone();
    assert_eq!(keys.len(), 1);
    assert!(keys[0].contains(&inputs_addr(away(), ARRIVE_BELL)));
    assert!(keys[0].contains(&day_addr(away(), ARRIVE_BELL)));
    assert!(keys[0].contains(&slot_addr(away(), ARRIVE_BELL, 0)));
    assert!(keys[0].contains(&host_transit_addr(SLOT)));
    let st = review.status();
    let r = &st["recent"][0];
    assert_eq!(
        r["hint"],
        format!("gather:{}:{}", hex::encode(away().to_bytes()), ARRIVE_BELL)
    );
    assert_eq!(r["outcome"], "candidate");
    assert_eq!(r["candidate"]["kind"], "WideGather");
    assert_eq!(r["candidate"]["coherent"], true);
    assert_eq!(r["candidate"]["facts"]["start"], 0);
    assert_eq!(r["candidate"]["signed"], false);
    assert_eq!(r["candidate"]["automatic_send"], false);
    assert_eq!(
        r["assessment"]["needs"]["creates"][0]["account"],
        "wide ClashInputs"
    );
    let denials = r["assessment"]["review"]["denials"].as_array().unwrap();
    for d in [
        "SourceUnproven",
        "HistoryUnknown",
        "SignerAbsent",
        "SliceDoesNotEnqueue",
    ] {
        assert!(denials.iter().any(|x| x == d), "{d}");
    }
    assert_eq!(r["assessment"]["review"]["admitted"], false);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(st["gather"]["plans"], 1);
    assert_eq!(st["gather"]["candidates"], 1);
    assert_eq!(st["enqueued"], 0);
    assert_eq!(st["automatic_writes"], false);
    // The window still open at the tick's clock: planned, blocked, nothing made.
    let cold = ClockedPort::new(fx.accounts(), gather_close() - 1);
    let mut review2 = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    assert_eq!(
        block_on(review2.step(
            &cold,
            &engine,
            &model,
            program(),
            season_pda().0,
            900,
            Some(&lit),
            None,
        )),
        1
    );
    assert_eq!(
        (
            review2.gather_plans,
            review2.gather_candidates,
            review2.blocked
        ),
        (1, 0, 1)
    );
    let r2 = &review2.status()["recent"][0];
    assert_eq!(r2["outcome"], "blocked");
    assert!(r2["block"].as_str().unwrap().starts_with("WindowOpen"));
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(cold.forbidden.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------ resolve fixture

/// The bell the fixture province resolves next (the gather fixture's
/// arrival bell, so THE anchor fixture is shared).
const RESOLVE_BELL: u32 = ARRIVE_BELL;
/// The SeedCache nonce the fixture poster chose (a literal: the handler
/// recomputes the address from the stored nonce).
const CACHE_NONCE: u8 = 3;
/// The bell seed the fixture cache carries (a literal 32 bytes).
const BELL_SEED: [u8; 32] = [0x5d; 32];
/// The ring seed the fixture terrain is generated from (public math).
const RING_SEED: [u8; 32] = [0x5e; 32];

/// The gather fixture Season with the quicknet clock and the MC conquest
/// block (`MC_LOCAL_7D`): what `SeasonClock::seed_round` and
/// `StepParams::of_season` read.
fn season_resolve() -> Vec<u8> {
    let mut d = season_ok();
    assert!(wr_arr(
        &mut d,
        SL::DRAND_GENESIS,
        &QUICKNET_GENESIS.to_le_bytes()
    ));
    assert!(wr_u32(&mut d, SL::DRAND_PERIOD, QUICKNET_PERIOD));
    d[SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + CONQUEST_PARAMS_LEN]
        .copy_from_slice(&MC_LOCAL_7D.cq.to_bytes());
    d
}
fn resolve_clock() -> SeasonClock {
    SeasonClock::from_season(&Season::decode(&season_resolve()).unwrap())
}
fn resolve_close() -> i64 {
    resolve_clock().reveal_close(RESOLVE_BELL, A_TS)
}
fn resolve_seed_round() -> u64 {
    resolve_clock().seed_round(RESOLVE_BELL, A_TS)
}
fn cache_addr(nonce: u8) -> Address {
    addr(ctx().seed_cache(RESOLVE_BELL, REGION, nonce))
}
/// A SeedCache as the beacon duty posts it: the fields `bell_seed` reads.
fn cache_bytes(
    bell: u32,
    region: u8,
    nonce: u8,
    round: u64,
    a: i64,
    anchor_key: Address,
) -> Vec<u8> {
    let mut d = vec![0u8; SC::SIZE];
    assert!(wr_arr(&mut d, SC::HDR_MAGIC, &SC::MAGIC));
    assert!(wr_u64(&mut d, SC::SEASON_ID, SEASON_ID));
    assert!(wr_u32(&mut d, SC::BELL, bell));
    assert!(wr_u8(&mut d, SC::REGION, region));
    assert!(wr_u8(&mut d, SC::NONCE, nonce));
    assert!(wr_u64(&mut d, SC::ROUND, round));
    assert!(wr_arr(&mut d, SC::SEED, &BELL_SEED));
    assert!(wr_arr(&mut d, SC::ANCHOR_KEY, &anchor_key.to_bytes()));
    assert!(wr_arr(&mut d, SC::A, &a.to_le_bytes()));
    d
}
/// The archive of the bell holding its entry with `a_off` **and** the
/// bell seed (the resolve's archive path takes the seed from it).
fn archive_with_seed(bell: u32, region: u8, a_off: u32) -> Vec<u8> {
    let mut d = archive_bytes(bell, region, Some(a_off));
    assert!(wr_arr(&mut d, AA::entry(bell) + AE::SEED, &BELL_SEED));
    d
}
fn fixture_terrain() -> ProvinceTerrain {
    generate_province(&RING_SEED, ProvinceCoord::new(3, -1))
}
/// A passable non-site tile of the fixture terrain that is not `not`.
fn free_tile(t: &ProvinceTerrain, not: Option<u8>) -> u8 {
    (1..PROVINCE_TILES as u8)
        .find(|&x| t.passable(x) && !t.is_site(x) && Some(x) != not)
        .unwrap()
}
/// A wide province the ABI's own bell model accepts (the layout the ABI's
/// `resolve` tests build): the identity, the generated terrain and sites,
/// `resolved_next` and the score bell at `b0`, every site free, a keep of
/// `holder` on a free tile with the preset's `keep_bells`, no camp with the
/// day's check due. Resident-only: no entry, no roster.
fn resolvable_province(k: ProvinceKey, b0: u32, holder: u8) -> Vec<u8> {
    resolvable_province_in(k, b0, holder, REGION)
}
/// [`resolvable_province`] with a stored region.
fn resolvable_province_in(k: ProvinceKey, b0: u32, holder: u8, region: u8) -> Vec<u8> {
    let mut pd = province_bytes_in(k, b0, region);
    let t = fixture_terrain();
    for i in 0..PROVINCE_TILES {
        pd[PV::TERRAIN + i] = TERRAINS.iter().position(|x| *x == t.terrain[i]).unwrap() as u8;
        pd[PV::RESOURCE + i] = match t.resource[i] {
            None => 0,
            Some(r) => 1 + RESOURCES.iter().position(|x| *x == r).unwrap() as u8,
        };
    }
    pd[PV::SITES..PV::SITES + PV::SITES_N].copy_from_slice(&t.sites);
    pd[PV::SITE_COUNT] = t.site_count;
    assert!(wr_u32(&mut pd, PV2::SCORE_NEXT_BELL, b0));
    for s in 0..PV::SITES_N {
        let o = PV::site(s);
        pd[o + SM::STATE] = SM::STATE_FREE;
        pd[o + SM::FACTION] = NEUTRAL;
        for pb in [SM::PEND0_BELL, SM::PEND1_BELL] {
            assert!(wr_u32(&mut pd, o + pb, SM::NO_BELL));
        }
    }
    let keep_tile = free_tile(&t, None);
    write_keep(
        &mut pd,
        &Keep {
            tile: keep_tile,
            holder,
            contender: NO_FACTION,
            progress: 0,
            required: MC_LOCAL_7D.cq.keep_bells as u8,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: 100,
            since_bell: b0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: NO_FACTION,
        },
    )
    .unwrap();
    Camp {
        tile: 0,
        state: CP::STATE_NONE,
        troops: 0,
        next_check_day: b0 / DAY_BELLS,
        gen: 0,
    }
    .write(&mut pd)
    .unwrap();
    pd
}
/// A fully gathered ClashInputs of `(dest, bell)` with one present arrival
/// of `host` (faction 0) at position 0 on `tile`.
fn resolve_inputs_bytes(dest: ProvinceKey, bell: u32, host: WideHostRef, tile: u8) -> Vec<u8> {
    let mut h = wa::WideClashInputsHdr::new(SEASON_ID, dest, bell, [0xB5; 32]);
    h.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    h.n_present = 1;
    let mut d = vec![0u8; wa::wide_clash_inputs::SIZE];
    h.write(&mut d).unwrap();
    wa::WideArrival {
        host,
        citizen: citizen(),
        dep_mass: TROOPS,
        troops: TROOPS,
        stamina: 61,
        retreat_bps: 0,
        dealt_bps: arrival_dealt_bps(),
        faction: 0,
        unit: 2,
        tile,
        stance: 0,
        present: true,
        fate: wa::wide_arrival::FATE_NONE,
        troops_after: 0,
    }
    .write_at(&mut d, 0)
    .unwrap();
    d
}

/// Every account a WideResolve of `home()` at `RESOLVE_BELL` reads, as it
/// would be when the bell is resolvable resident-only: THE anchor at
/// `A_TS`, a SeedCache of it at `CACHE_NONCE` with the seed round, no
/// roster (no entry is live), no ClashInputs, no ArrivalDay, the clock at
/// the Season's own reveal close.
struct ResolveFx {
    season: Vec<u8>,
    province: Option<Vec<u8>>,
    roster: Option<Vec<u8>>,
    anchor: Option<Vec<u8>>,
    archive: Option<Vec<u8>>,
    /// SeedCaches by nonce.
    caches: BTreeMap<u8, Vec<u8>>,
    inputs: Option<Vec<u8>>,
    day: Option<Vec<u8>>,
    clock: Option<ClockSysvar>,
}
impl ResolveFx {
    fn new() -> ResolveFx {
        let mut caches = BTreeMap::new();
        caches.insert(
            CACHE_NONCE,
            cache_bytes(
                RESOLVE_BELL,
                REGION,
                CACHE_NONCE,
                resolve_seed_round(),
                A_TS,
                anchor_addr(RESOLVE_BELL, REGION),
            ),
        );
        ResolveFx {
            season: season_resolve(),
            province: Some(resolvable_province(home(), RESOLVE_BELL, 0)),
            roster: None,
            anchor: Some(anchor_bytes(RESOLVE_BELL, REGION, A_TS, 1)),
            archive: None,
            caches,
            inputs: None,
            day: None,
            clock: Some(clock_ts(900, resolve_close())),
        }
    }
    fn accounts(&self) -> BTreeMap<Address, Option<Account>> {
        let mut m = BTreeMap::new();
        m.insert(season_pda().0, acct(self.season.clone()));
        m.insert(province_addr(home()), self.province.clone().and_then(acct));
        m.insert(roster_addr(home()), self.roster.clone().and_then(acct));
        m.insert(
            anchor_addr(RESOLVE_BELL, REGION),
            self.anchor.clone().and_then(acct),
        );
        m.insert(
            archive_addr(RESOLVE_BELL, REGION),
            self.archive.clone().and_then(acct),
        );
        for (n, c) in &self.caches {
            m.insert(cache_addr(*n), acct(c.clone()));
        }
        m.insert(
            inputs_addr(home(), RESOLVE_BELL),
            self.inputs.clone().and_then(acct),
        );
        m.insert(
            day_addr(home(), RESOLVE_BELL),
            self.day.clone().and_then(acct),
        );
        m
    }
    fn reads(&self) -> Reads {
        let mut r = Reads::new(0);
        r.accounts = self.accounts();
        // The cache the plan may ask for at the fixture nonce, absent when
        // the fixture holds none (an unread key would stop `done`).
        r.accounts.entry(cache_addr(CACHE_NONCE)).or_insert(None);
        r.clock = self.clock;
        r
    }
    fn plan(&self, nonce: Option<u8>) -> Result<Candidate, Block> {
        done(wideduty::plan_resolve(
            &dscope(),
            payer(),
            actor(),
            home(),
            nonce,
            &self.reads(),
        ))
    }
}

fn resolve_facts(c: &Candidate) -> &wideduty::ResolveFacts {
    match &c.duty {
        Duty::Resolve(f) => f,
        other => panic!("not a resolve: {other:?}"),
    }
}

/// The newest review ledger entry (its hint, outcome and block code or
/// candidate), for assertion messages: a failed expectation names the
/// Block the planner hit.
fn last_entry(review: &WideReview) -> Value {
    review.status()["recent"][0].clone()
}
/// The newest entry is a candidate; the message is the entry otherwise.
fn assert_last_is_candidate(review: &WideReview) {
    let e = last_entry(review);
    assert_eq!(e["outcome"], "candidate", "last review entry: {e}");
}

/// Resident-only: the handler's nine accounts in its roles (the inputs
/// read-only when absent), the ABI's `Resolve` data, the seed from the
/// cache at the stored nonce, the bell model run on scratch bytes (no
/// entry, no roster: nothing created), the input digest the test computes
/// itself, the fee review creating nothing; the same through the live
/// read driver in three waves.
#[test]
fn a_resident_only_resolve_candidate_runs_the_bell_model_on_scratch_bytes() {
    let fx = ResolveFx::new();
    let c = fx.plan(Some(CACHE_NONCE)).unwrap();
    let f = resolve_facts(&c);
    assert_eq!(
        (f.province, f.bell, f.region, f.beneficiary),
        (home(), RESOLVE_BELL, REGION, actor())
    );
    assert_eq!(
        (f.seed_source, f.seed_nonce, f.seed_round),
        ("cache", Some(CACHE_NONCE), resolve_seed_round())
    );
    assert_eq!(
        (f.anchor_source, f.a_ts, f.reveal_close, f.judged_at),
        ("anchor", A_TS, resolve_close(), resolve_close())
    );
    assert!(!f.arrivals_expected && !f.inputs_present && f.n_arrivals == 0);
    assert!(!f.roster_present && !f.roster_created);
    assert_eq!(
        (f.live_entries_before, f.engagements, f.destroyed, f.bounced),
        (0, 0, 0, 0)
    );
    assert_eq!(
        f.resolved_ts_at_observed_clock,
        (resolve_close() - GENESIS_TS) as u32
    );
    // The input commitment over the bytes as read: the Season whole, the
    // province, the would-be roster header with the payer as its rent
    // recipient, no inputs.
    let mut roster_hdr = vec![0u8; wro::wide_roster::SIZE];
    WideRoster::new(SEASON_ID, home(), payer().to_bytes())
        .write_header(&mut roster_hdr)
        .unwrap();
    assert_eq!(
        f.input_digest,
        wev::resolve_input_digest(
            home(),
            RESOLVE_BELL,
            &BELL_SEED,
            &fx.season,
            fx.province.as_ref().unwrap(),
            &roster_hdr,
            &[]
        )
    );
    let a = &c.instruction.accounts;
    let roles: Vec<(Address, bool, bool)> = a
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(
        roles,
        vec![
            (payer(), true, true),
            (season_pda().0, false, false),
            (province_addr(home()), false, true),
            (roster_addr(home()), false, true),
            (cache_addr(CACHE_NONCE), false, false),
            (anchor_addr(RESOLVE_BELL, REGION), false, false),
            (inputs_addr(home(), RESOLVE_BELL), false, false),
            (day_addr(home(), RESOLVE_BELL), false, false),
            (fclient::addr::system_program(), false, false),
        ]
    );
    assert_eq!(
        c.instruction.data,
        Resolve {
            bell: RESOLVE_BELL,
            beneficiary: actor().to_bytes(),
        }
        .to_bytes()
        .to_vec()
    );
    assert!(!c.signed && !c.automatic_send && !c.coherent());
    let d = c.describe();
    assert_eq!(d["kind"], "WideResolve");
    assert_eq!(d["facts"]["seed_source"], "cache");
    let needs = widefees::duty_needs(&c, &fx.reads()).unwrap();
    assert!(needs.creates.is_empty());
    assert_eq!(needs.rent_rule, widefees::RENT_RULE_NONE);
    // A present roster of the province: taken as is.
    let mut with_roster = ResolveFx::new();
    with_roster.roster = Some(roster_bytes(home(), &[]).0);
    let f2 = resolve_facts(&with_roster.plan(Some(CACHE_NONCE)).unwrap()).clone();
    assert!(f2.roster_present && !f2.roster_created);
    // Through the live read driver: three waves at the requested bound.
    let port = ClockedPort::new(fx.accounts(), resolve_close());
    let via = block_on(wideduty::resolve_via(
        &port,
        &dscope(),
        payer(),
        actor(),
        home(),
        Some(CACHE_NONCE),
        321,
    ))
    .unwrap();
    assert_eq!(via.instruction, c.instruction);
    assert_eq!(*port.min_slots.lock().unwrap(), vec![321, 321, 321]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

/// Gathered arrivals: the ArrivalDay's bit set and the record complete,
/// the inputs writable, the bell model taking the one arrival; an arrival
/// that stays claims an entry in the absent roster, so the handler creates
/// the roster from the fee payer, who must hold its **full** minimum
/// balance (the handler's guard; not the gather's top-up netting).
/// Incomplete or resolved records and another bell's record are refused.
#[test]
fn a_resolve_with_gathered_arrivals_predicts_the_roster_creation_and_its_full_rent() {
    let t = fixture_terrain();
    let keep_tile = free_tile(&t, None);
    let tile = free_tile(&t, Some(keep_tile));
    let mut fx = ResolveFx::new();
    fx.day = Some(gather_day_bytes(home(), RESOLVE_BELL, true));
    fx.inputs = Some(resolve_inputs_bytes(home(), RESOLVE_BELL, host_b(), tile));
    let c = fx.plan(Some(CACHE_NONCE)).unwrap();
    let f = resolve_facts(&c);
    assert!(f.arrivals_expected && f.inputs_present);
    assert_eq!(f.n_arrivals, 1);
    assert!(
        c.instruction.accounts[6].is_writable,
        "the record is written"
    );
    assert!(
        f.roster_created,
        "the lone arrival of the keep holder's faction stays and claims an entry"
    );
    assert!(!f.roster_present);
    let needs = widefees::duty_needs(&c, &fx.reads()).unwrap();
    assert_eq!(needs.creates, vec![("wide Roster", wro::wide_roster::SIZE)]);
    assert_eq!(needs.rent_rule, widefees::RENT_RULE_FULL);
    // Over one snapshot with the Rent: the payer must hold the full
    // minimum plus the fee; one lamport short is unmet.
    let minimum = RENT_FIXTURE
        .minimum_balance(wro::wide_roster::SIZE)
        .unwrap();
    let wallet = |lamports: u64| {
        Some(Account {
            lamports,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        })
    };
    let needs_with = |payer_lamports: u64| {
        let mut accounts = fx.accounts();
        accounts.insert(payer(), wallet(payer_lamports));
        let keys: Vec<Address> = accounts.keys().copied().collect();
        let snap = snapshot_of_rent(&accounts, &keys, clock_ts(2_000, resolve_close()), 7);
        let reads = snap.reads();
        let c = done(wideduty::plan_resolve(
            &dscope(),
            payer(),
            actor(),
            home(),
            Some(CACHE_NONCE),
            &reads,
        ))
        .unwrap();
        assert!(c.coherent());
        widefees::duty_needs(&c, &reads).unwrap()
    };
    let n = needs_with(minimum + 5_000);
    assert_eq!(n.rent_lamports, Known::Known(minimum));
    assert_eq!(n.prefunded_lamports, 0);
    assert_eq!(n.required_lower_bound, Known::Known(minimum + 5_000));
    assert_eq!(
        n.funding,
        Funding::MetLowerBound {
            payer_lamports: minimum + 5_000,
            required: minimum + 5_000
        }
    );
    let n = needs_with(minimum + 4_999);
    assert_eq!(
        n.funding,
        Funding::Unmet {
            payer_lamports: minimum + 4_999,
            required: minimum + 5_000,
            short: 1
        }
    );
    // The bit set and no record: a gather comes first.
    let mut fx = ResolveFx::new();
    fx.day = Some(gather_day_bytes(home(), RESOLVE_BELL, true));
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotGathered { bell: RESOLVE_BELL }
    );
    // A partial record.
    fx.inputs = Some(inputs_bytes(home(), RESOLVE_BELL, 0b111, 0, &[]));
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotGathered { bell: RESOLVE_BELL }
    );
    // A resolved record.
    fx.inputs = Some(inputs_bytes(
        home(),
        RESOLVE_BELL,
        wa::wide_clash_inputs::ALL_GATHERED,
        wa::wide_clash_inputs::FLAG_RESOLVED,
        &[],
    ));
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::AlreadyResolved
    );
    // Another bell's record at the address.
    fx.inputs = Some(inputs_bytes(
        home(),
        RESOLVE_BELL + 1,
        wa::wide_clash_inputs::ALL_GATHERED,
        0,
        &[],
    ));
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotCanonical("inputs")
    );
    // The bit clear with a complete record: the residents and the record
    // (the handler takes a present record whatever the bit says).
    let mut fx = ResolveFx::new();
    fx.inputs = Some(inputs_bytes(
        home(),
        RESOLVE_BELL,
        wa::wide_clash_inputs::ALL_GATHERED,
        0,
        &[],
    ));
    let f = resolve_facts(&fx.plan(Some(CACHE_NONCE)).unwrap()).clone();
    assert!(!f.arrivals_expected && f.inputs_present && f.n_arrivals == 0);
}

/// The seed, the anchor, the identities and the timing, each from literal
/// bytes: no nonce supplied; the cache absent at the nonce; another
/// bell's cache; a cache whose stored nonce is not the address's; a cache
/// of another round or another anchor; the archive path with the same
/// account in both positions; an archive without the bell; another
/// province's roster; the province absent, legacy, of another world; the
/// window open by a second; no clock; the end bell; a Season without the
/// conquest block.
#[test]
fn a_resolve_blocks_on_wrong_cache_archive_identity_and_timing() {
    let fx = ResolveFx::new();
    assert_eq!(
        fx.plan(None).unwrap_err(),
        Block::SeedNonceUnknown {
            bell: RESOLVE_BELL,
            region: REGION
        }
    );
    let mut fx = ResolveFx::new();
    fx.caches.clear();
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::SeedNotReady("cache absent at the nonce")
    );
    let anchor_key = anchor_addr(RESOLVE_BELL, REGION);
    let mut fx = ResolveFx::new();
    fx.caches.insert(
        CACHE_NONCE,
        cache_bytes(
            RESOLVE_BELL + 1,
            REGION,
            CACHE_NONCE,
            resolve_seed_round(),
            A_TS,
            anchor_key,
        ),
    );
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotCanonical("seedcache")
    );
    let mut fx = ResolveFx::new();
    fx.caches.insert(
        CACHE_NONCE,
        cache_bytes(
            RESOLVE_BELL,
            REGION,
            CACHE_NONCE + 1,
            resolve_seed_round(),
            A_TS,
            anchor_key,
        ),
    );
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotCanonical("seedcache"),
        "the stored nonce recomputes another address"
    );
    let mut fx = ResolveFx::new();
    fx.caches.insert(
        CACHE_NONCE,
        cache_bytes(
            RESOLVE_BELL,
            REGION,
            CACHE_NONCE,
            resolve_seed_round() + 1,
            A_TS,
            anchor_key,
        ),
    );
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::SeedNotReady("cache does not match THE anchor")
    );
    let mut fx = ResolveFx::new();
    fx.caches.insert(
        CACHE_NONCE,
        cache_bytes(
            RESOLVE_BELL,
            REGION,
            CACHE_NONCE,
            resolve_seed_round(),
            A_TS,
            actor(),
        ),
    );
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::SeedNotReady("cache does not match THE anchor")
    );
    // The archive path: THE anchor gone, the bell archived with its seed:
    // the same account in the seed and the anchor positions, no nonce.
    let mut fx = ResolveFx::new();
    fx.anchor = None;
    fx.caches.clear();
    fx.archive = Some(archive_with_seed(RESOLVE_BELL, REGION, 5));
    let a_arch = bell_end(GENESIS_TS, RESOLVE_BELL) + 5;
    fx.clock = Some(clock_ts(
        900,
        resolve_clock().reveal_close(RESOLVE_BELL, a_arch),
    ));
    let c = fx.plan(None).unwrap();
    let f = resolve_facts(&c);
    assert_eq!(
        (f.seed_source, f.seed_nonce, f.anchor_source, f.a_ts),
        ("archive", None, "archive", a_arch)
    );
    assert_eq!(
        f.seed_round,
        resolve_clock().seed_round(RESOLVE_BELL, a_arch)
    );
    let arch = archive_addr(RESOLVE_BELL, REGION);
    assert_eq!(
        (
            c.instruction.accounts[4].pubkey,
            c.instruction.accounts[5].pubkey
        ),
        (arch, arch)
    );
    fx.archive = Some(archive_bytes(RESOLVE_BELL, REGION, None));
    assert_eq!(
        fx.plan(None).unwrap_err(),
        Block::NoAnchor("archive without the bell")
    );
    // Identities.
    let mut fx = ResolveFx::new();
    fx.roster = Some(roster_bytes(away(), &[]).0);
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::NotCanonical("roster")
    );
    let mut fx = ResolveFx::new();
    fx.province = None;
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::Absent("province")
    );
    let mut fx = ResolveFx::new();
    fx.province = Some(legacy_province_bytes());
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::Unreadable("province")
    );
    let fx = ResolveFx::new();
    assert_eq!(
        done(wideduty::plan_resolve(
            &dscope(),
            payer(),
            actor(),
            ProvinceKey::new(other_world(), home().coord()),
            Some(CACHE_NONCE),
            &fx.reads()
        ))
        .unwrap_err(),
        Block::World
    );
    // Timing.
    let mut fx = ResolveFx::new();
    fx.clock = Some(clock_ts(900, resolve_close() - 1));
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::WindowOpen {
            reveal_close: resolve_close(),
            now: resolve_close() - 1
        }
    );
    let mut fx = ResolveFx::new();
    fx.clock = None;
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::TimingNeedsClock
    );
    let mut fx = ResolveFx::new();
    let mut ended = season_resolve();
    assert!(wr_u32(&mut ended, SL::END_BELL, RESOLVE_BELL));
    fx.season = ended;
    assert_eq!(fx.plan(Some(CACHE_NONCE)).unwrap_err(), Block::SeasonEnded);
    // No conquest block: the step parameters are unknown.
    let mut fx = ResolveFx::new();
    let mut plain = season_ok();
    assert!(wr_arr(
        &mut plain,
        SL::DRAND_GENESIS,
        &QUICKNET_GENESIS.to_le_bytes()
    ));
    assert!(wr_u32(&mut plain, SL::DRAND_PERIOD, QUICKNET_PERIOD));
    fx.season = plain;
    assert_eq!(
        fx.plan(Some(CACHE_NONCE)).unwrap_err(),
        Block::ConquestParams
    );
}

/// A resolve candidate planned over one snapshot is coherent and bound to
/// its content: another resolver, another roster claim or another digest
/// loses the snapshot, the fee bound and the snapshot denial change; every
/// hard denial stands.
#[test]
fn a_resolve_candidate_is_bound_to_its_snapshot_and_content() {
    let fx = ResolveFx::new();
    let accounts = fx.accounts();
    let keys: Vec<Address> = accounts.keys().copied().collect();
    let snap = snapshot_of_rent(&accounts, &keys, clock_ts(2_000, resolve_close()), 7);
    let reads = snap.reads();
    let c = done(wideduty::plan_resolve(
        &dscope(),
        payer(),
        actor(),
        home(),
        Some(CACHE_NONCE),
        &reads,
    ))
    .unwrap();
    assert!(c.coherent());
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let open = EngineView::of(&engine, &widereview::Subject::of_duty(&c));
    let a = widereview::review_candidate(&c, &reads, &open);
    assert!(!a.review.admitted);
    assert!(a.snapshot.is_some());
    for d in [
        Deny::SourceUnproven,
        Deny::HistoryUnknown,
        Deny::SignerAbsent,
        Deny::SliceDoesNotEnqueue,
    ] {
        assert!(a.review.denials.contains(&d), "{d:?}");
    }
    assert!(a.review.subject.key.starts_with("wide-resolve:"));
    assert!(a.review.subject.key.ends_with(&format!(":{RESOLVE_BELL}")));
    let mut m = c.clone();
    if let Duty::Resolve(f) = &mut m.duty {
        f.beneficiary = payer();
    }
    lost_everything("beneficiary", &m, &reads, &open);
    let mut m = c.clone();
    if let Duty::Resolve(f) = &mut m.duty {
        f.roster_created = true;
    }
    lost_everything("roster_created", &m, &reads, &open);
    let mut m = c.clone();
    if let Duty::Resolve(f) = &mut m.duty {
        f.output_digest_at_observed_clock[0] ^= 1;
    }
    lost_everything("output digest", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[6].is_writable = true;
    lost_everything("inputs flag", &m, &reads, &open);
}

/// Resolve hints are the observed provinces not seen closed, in key order;
/// the plan reads the current bell from the chain.
#[test]
fn resolve_hints_are_the_observed_open_provinces() {
    let mut d = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    assert!(wideduty::resolve_candidates(&d).is_empty());
    d.apply(&WideBatch {
        seq: 1,
        slot: 1_001,
        signature: "sig-1".into(),
        bodies: vec![departed_ok(home())],
    })
    .unwrap();
    assert_eq!(wideduty::resolve_candidates(&d), vec![home()]);
    d.apply(&WideBatch {
        seq: 2,
        slot: 1_002,
        signature: "sig-2".into(),
        bodies: vec![encode(
            WideKind::ProvinceClosed,
            DEPART_BELL + 1,
            &home().to_bytes(),
            &wev::province_closed_payload(&[0xd5; 32], 5),
            &[link(WideEntity::Province, 1)],
        )
        .unwrap()],
    })
    .unwrap();
    assert!(
        wideduty::resolve_candidates(&d).is_empty(),
        "closed: no hint"
    );
}

/// The tick: no resolve hint without a configured resolver; with one, the
/// province's current bell is planned **once** per tick — the nonce
/// unknown, the tick's one bounded probe of the 256 cache addresses stores
/// what it found and the hint waits for the next slot; then the plan with
/// the nonce over one snapshot with the Rent — a coherent candidate
/// reviewed with every hard denial and nothing enqueued; every tick's port
/// reads counted; a bell whose arrivals are not gathered blocks
/// `NotGathered` and lists a gather of that bell next.
#[test]
fn the_tick_plans_a_resolve_after_a_bounded_nonce_probe_and_enqueues_nothing() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![departed_ok(home())],
        })
        .unwrap();
    model
        .apply(&WideBatch {
            seq: 2,
            slot: 1_002,
            signature: "sig-2".into(),
            bodies: vec![both(
                WideKind::DepartureSettled,
                DEPART_BELL + 1,
                &wev::host_key(&host(), home()),
                &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
            )],
        })
        .unwrap();
    let fx = ResolveFx::new();
    let port = ClockedPort::new(fx.accounts(), resolve_close());
    let mut lit = LiteralSnapshots::new(fx.accounts());
    lit.clock_ts = resolve_close();
    lit.serve_at_requested_slot = true;
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    // No resolver configured: no resolve hint.
    assert_eq!(
        block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            900,
            Some(&lit),
            None
        )),
        0
    );
    assert!(review.set_resolve_beneficiary(Address::default()).is_err());
    review.set_resolve_beneficiary(actor()).unwrap();
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    // Discovery: one plan (two learning reads), the tick's one probe (four
    // chunks), nothing else — no second plan, no snapshot; the hint waits
    // for the next slot with the found nonce pending.
    assert_eq!(
        (
            review.plans,
            review.resolve_plans,
            review.seed_probes,
            review.resolve_candidates,
            review.blocked
        ),
        (1, 1, 1, 0, 1)
    );
    assert_eq!(port.min_slots.lock().unwrap().len(), 2 + 4);
    assert!(lit.keys.lock().unwrap().is_empty());
    assert_eq!(
        review.pending_nonces(RESOLVE_BELL, REGION),
        vec![CACHE_NONCE]
    );
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, REGION), None);
    {
        let r0 = &review.status()["recent"][0];
        assert_eq!(r0["outcome"], "blocked");
        assert!(r0["block"]
            .as_str()
            .unwrap()
            .starts_with("SeedNonceUnknown"));
        assert_eq!(r0["next"], "next slot: a nonce to try");
    }
    // The next slot: the one plan with the pending nonce, over one
    // snapshot holding the cache's address.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        901,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert_last_is_candidate(&review);
    assert_eq!(
        (
            review.plans,
            review.resolve_plans,
            review.seed_probes,
            review.resolve_candidates,
            review.coherent,
            review.blocked
        ),
        (2, 2, 1, 1, 1, 1)
    );
    assert_eq!(port.min_slots.lock().unwrap().len(), 2 + 4 + 3);
    let keys = lit.keys.lock().unwrap().clone();
    assert_eq!(keys.len(), 1);
    assert!(keys[0].contains(&cache_addr(CACHE_NONCE)));
    assert_eq!(
        review.remembered_nonce(RESOLVE_BELL, REGION),
        Some(CACHE_NONCE)
    );
    assert!(review.pending_nonces(RESOLVE_BELL, REGION).is_empty());
    let st = review.status();
    let r = &st["recent"][0];
    assert_eq!(
        r["hint"],
        format!("resolve:{}", hex::encode(home().to_bytes()))
    );
    assert_eq!(r["outcome"], "candidate");
    assert_eq!(r["candidate"]["kind"], "WideResolve");
    assert_eq!(r["candidate"]["coherent"], true);
    assert_eq!(r["candidate"]["facts"]["seed_nonce"], CACHE_NONCE);
    let denials = r["assessment"]["review"]["denials"].as_array().unwrap();
    for d in [
        "SourceUnproven",
        "HistoryUnknown",
        "SignerAbsent",
        "SliceDoesNotEnqueue",
    ] {
        assert!(denials.iter().any(|x| x == d), "{d}");
    }
    assert_eq!(r["assessment"]["review"]["admitted"], false);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(st["resolve"]["candidates"], 1);
    assert_eq!(st["resolve"]["seed_nonces_remembered"], 1);
    assert_eq!(st["enqueued"], 0);
    assert!(review.gather_followups().is_empty());
    // The remembered nonce: no probe the next time.
    let mut again = ResolveFx::new();
    again.day = Some(gather_day_bytes(home(), RESOLVE_BELL, true));
    let port2 = ClockedPort::new(again.accounts(), resolve_close());
    let mut lit2 = LiteralSnapshots::new(again.accounts());
    lit2.clock_ts = resolve_close();
    lit2.serve_at_requested_slot = true;
    let made = block_on(review.step(
        &port2,
        &engine,
        &model,
        program(),
        season_pda().0,
        1_000,
        Some(&lit2),
        None,
    ));
    assert_eq!(made, 1);
    assert_eq!((review.seed_probes, review.blocked), (1, 2));
    assert_eq!(
        port2.min_slots.lock().unwrap().len(),
        3,
        "one plan with the remembered nonce"
    );
    let r2 = &review.status()["recent"][0];
    assert_eq!(r2["outcome"], "blocked");
    assert_eq!(
        r2["block"],
        format!("NotGathered {{ bell: {RESOLVE_BELL} }}")
    );
    assert_eq!(review.gather_followups(), vec![(home(), RESOLVE_BELL)]);
    // The next tick lists the gather of that bell (and plans it).
    let made = block_on(review.step(
        &port2,
        &engine,
        &model,
        program(),
        season_pda().0,
        1_100,
        Some(&lit2),
        None,
    ));
    assert!(made >= 1);
    let st3 = review.status();
    let hints: Vec<String> = st3["recent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["hint"].as_str().unwrap().to_string())
        .collect();
    assert!(
        hints.contains(&format!(
            "gather:{}:{}",
            hex::encode(home().to_bytes()),
            RESOLVE_BELL
        )),
        "{hints:?}"
    );
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port2.forbidden.load(Ordering::SeqCst), 0);
}

/// Liveness: seventy observed provinces (more than any fixed hint window)
/// are all listed, and the tick's rotating cursor reaches every one of
/// them under the two-plans-per-tick cap — the one ready province among
/// them is planned to a candidate wherever its key sorts; the others block
/// on their absence and never starve it or each other.
#[test]
fn resolve_hints_rotate_over_every_observed_province_under_the_plan_cap() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    // Musters (no transit: no settle or return hint) in seventy provinces
    // of the home ring: `home()` and sixty-nine others.
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    for i in 0..70u32 {
        let standing = if i == 0 {
            home()
        } else {
            key(world(), 129, -(i as i64))
        };
        let h = WideHostRef::new(home(), SITE, GEN, 100 + i).unwrap();
        bodies.push(both(
            WideKind::Muster,
            4,
            &wev::host_key(&h, standing),
            &wev::muster_payload(2, TROOPS, 5, 0, 1 + i as u64),
        ));
    }
    for (n, chunk) in bodies.chunks(32).enumerate() {
        model
            .apply(&WideBatch {
                seq: n as u64 + 1,
                slot: 1_000 + n as u64,
                signature: format!("sig-{n}"),
                bodies: chunk.to_vec(),
            })
            .unwrap();
    }
    assert_eq!(
        wideduty::resolve_candidates(&model).len(),
        70,
        "nothing is cut"
    );
    assert!(wideduty::settle_candidates(&model).is_empty());
    assert!(wideduty::return_candidates(&model).is_empty());
    let fx = ResolveFx::new();
    let port = ClockedPort::new(fx.accounts(), resolve_close());
    let mut lit = LiteralSnapshots::new(fx.accounts());
    lit.clock_ts = resolve_close();
    lit.serve_at_requested_slot = true;
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    review.set_resolve_beneficiary(actor()).unwrap();
    assert_eq!(review.cap(), 2);
    // Thirty-five ticks, each exactly two plans: every hint once (the
    // ready one reaches its discovery: the tick's probe, its nonce
    // pending).
    for i in 0..35u64 {
        let made = block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            900 + 100 * i,
            Some(&lit),
            None,
        ));
        assert_eq!(made, 2, "tick {i}");
    }
    assert_eq!((review.plans, review.resolve_plans), (70, 70));
    assert_eq!(
        review.status()["ledger"],
        70,
        "every province inspected once"
    );
    assert_eq!(
        (
            review.resolve_candidates,
            review.seed_probes,
            review.blocked
        ),
        (0, 1, 70),
        "one discovery, every absent province blocked"
    );
    // Thirty-five more: the second rotation plans the ready one with its
    // pending nonce.
    for i in 35..70u64 {
        let made = block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            900 + 100 * i,
            Some(&lit),
            None,
        ));
        assert_eq!(made, 2, "tick {i}");
    }
    assert_eq!((review.plans, review.resolve_plans), (140, 140));
    assert_eq!(review.status()["ledger"], 70);
    assert_eq!(
        (
            review.resolve_candidates,
            review.seed_probes,
            review.blocked
        ),
        (1, 1, 139),
        "the ready one planned to a candidate wherever its key sorts; recent entries: {}",
        review.status()["recent"]
    );
    // Reads: one per absent province per rotation (its first wave finds
    // it absent), the ready one's discovery (2 + 4) and its plan (3).
    assert_eq!(port.min_slots.lock().unwrap().len(), 69 * 2 + (2 + 4) + 3);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // The next tick starts the rotation again (the first two hints, now
    // past their refresh).
    assert_eq!(
        block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            900 + 7_000,
            Some(&lit),
            None
        )),
        2
    );
    assert_eq!(review.resolve_plans, 142);
}

/// The shared cap holds across resolve hints: two provinces of different
/// regions both needing discovery in one tick make exactly two plans and
/// one probe — the second hint is deferred, reading nothing — and both
/// reach a candidate over the following slots; the counters are the
/// port's calls.
#[test]
fn two_resolve_hints_share_the_plan_cap_and_the_one_probe_per_tick() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    let mut bodies = Vec::new();
    for (i, standing) in [home(), away()].into_iter().enumerate() {
        let h = WideHostRef::new(home(), SITE, GEN, 200 + i as u32).unwrap();
        bodies.push(both(
            WideKind::Muster,
            4,
            &wev::host_key(&h, standing),
            &wev::muster_payload(2, TROOPS, 5, 0, 1 + i as u64),
        ));
    }
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies,
        })
        .unwrap();
    assert_eq!(wideduty::resolve_candidates(&model).len(), 2);
    // `home()` in region 0 (the fixture), `away()` in region 1 with its
    // own anchor and a cache at nonce 5.
    let fx = ResolveFx::new();
    let mut accounts = fx.accounts();
    accounts.insert(
        province_addr(away()),
        acct(resolvable_province_in(away(), RESOLVE_BELL, 0, 1)),
    );
    accounts.insert(
        anchor_addr(RESOLVE_BELL, 1),
        acct(anchor_bytes(RESOLVE_BELL, 1, A_TS, 1)),
    );
    accounts.insert(
        addr(ctx().seed_cache(RESOLVE_BELL, 1, 5)),
        acct(cache_bytes(
            RESOLVE_BELL,
            1,
            5,
            resolve_seed_round(),
            A_TS,
            anchor_addr(RESOLVE_BELL, 1),
        )),
    );
    let port = ClockedPort::new(accounts.clone(), resolve_close());
    let mut lit = LiteralSnapshots::new(accounts);
    lit.clock_ts = resolve_close();
    lit.serve_at_requested_slot = true;
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    review.set_resolve_beneficiary(actor()).unwrap();
    // Tick 1: two plans (two learning reads each), one probe (four
    // chunks), the other hint deferred.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        900,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 2);
    assert_eq!(
        (
            review.plans,
            review.seed_probes,
            review.seed_probes_deferred,
            review.resolve_candidates
        ),
        (2, 1, 1, 0)
    );
    assert_eq!(port.min_slots.lock().unwrap().len(), 2 + 4 + 2);
    assert!(lit.keys.lock().unwrap().is_empty());
    // Tick 2: the probed one plans with its nonce (a candidate); the
    // deferred one gets this tick's probe.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        901,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 2);
    assert_eq!(
        (
            review.plans,
            review.seed_probes,
            review.seed_probes_deferred,
            review.resolve_candidates
        ),
        (4, 2, 1, 1),
        "recent entries: {}",
        review.status()["recent"]
    );
    assert_eq!(port.min_slots.lock().unwrap().len(), 8 + 3 + 2 + 4);
    assert_eq!(lit.keys.lock().unwrap().len(), 1);
    // Tick 3: the other one plans with its nonce; the first waits for its
    // refresh.
    let made = block_on(review.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        902,
        Some(&lit),
        None,
    ));
    assert_eq!(made, 1);
    assert_last_is_candidate(&review);
    assert_eq!(
        (review.plans, review.seed_probes, review.resolve_candidates),
        (5, 2, 2)
    );
    assert_eq!(port.min_slots.lock().unwrap().len(), 17 + 3);
    assert_eq!(lit.keys.lock().unwrap().len(), 2);
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, 0), Some(CACHE_NONCE));
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, 1), Some(5));
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

/// Recovery, one plan per tick: a probed nonce whose cache the plan
/// refuses cools down (not blacklisted) and the next probed nonce is tried
/// at the next slot; a remembered nonce whose cache stops matching THE
/// anchor is forgotten and cools down; while every probed nonce cools the
/// hint blocks and nothing is substituted inside a sealed snapshot; once
/// the cooldown ends the **same** nonce is tried again and, its cache
/// corrected, accepted. Every tick's port reads are counted.
#[test]
fn a_refused_seed_cache_is_forgotten_and_rediscovered_with_bounded_reads() {
    let mut model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: literal bodies".into(),
        },
        Limits::default(),
    );
    model
        .apply(&WideBatch {
            seq: 1,
            slot: 1_001,
            signature: "sig-1".into(),
            bodies: vec![
                departed_ok(home()),
                both(
                    WideKind::DepartureSettled,
                    DEPART_BELL + 1,
                    &wev::host_key(&host(), home()),
                    &wev::departure_settled_payload(SLOT, false, TROOPS, 61, 0, 4),
                ),
            ],
        })
        .unwrap();
    let anchor_key = anchor_addr(RESOLVE_BELL, REGION);
    let good = |nonce: u8| {
        cache_bytes(
            RESOLVE_BELL,
            REGION,
            nonce,
            resolve_seed_round(),
            A_TS,
            anchor_key,
        )
    };
    let bad = |nonce: u8| {
        cache_bytes(
            RESOLVE_BELL,
            REGION,
            nonce,
            resolve_seed_round() + 1,
            A_TS,
            anchor_key,
        )
    };
    let mut fx = ResolveFx::new();
    fx.caches.clear();
    fx.caches.insert(1, bad(1));
    fx.caches.insert(3, good(3));
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut review = WideReview::new(Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    });
    review.set_resolve_beneficiary(actor()).unwrap();
    let cooldown = keeper_core::widetick::BAD_NONCE_COOLDOWN_SLOTS;
    // One tick: a fresh port and snapshot source over the fixture as it
    // stands; returns (made, port reads, snapshots taken).
    let tick = |review: &mut WideReview, fx: &ResolveFx, slot: u64| -> (u64, usize, usize) {
        let port = ClockedPort::new(fx.accounts(), resolve_close());
        let mut lit = LiteralSnapshots::new(fx.accounts());
        lit.clock_ts = resolve_close();
        lit.serve_at_requested_slot = true;
        let made = block_on(review.step(
            &port,
            &engine,
            &model,
            program(),
            season_pda().0,
            slot,
            Some(&lit),
            None,
        ));
        assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
        let reads = port.min_slots.lock().unwrap().len();
        let snaps = lit.keys.lock().unwrap().len();
        (made, reads, snaps)
    };
    // Slot 900: discovery — the plan (2 reads), the probe (4): nonces 1
    // and 3 pending; nothing else this tick.
    assert_eq!(tick(&mut review, &fx, 900), (1, 6, 0));
    assert_eq!(review.pending_nonces(RESOLVE_BELL, REGION), vec![1, 3]);
    // Slot 901: nonce 1 tried (3 reads), refused: cooling down, no
    // snapshot; 3 waits for the next slot; the key is learned again.
    assert_eq!(tick(&mut review, &fx, 901), (1, 3, 0));
    assert_eq!(
        review.bad_nonces(RESOLVE_BELL, REGION),
        vec![(1, 901 + cooldown)]
    );
    assert_eq!(review.pending_nonces(RESOLVE_BELL, REGION), vec![3]);
    assert_eq!(review.seed_nonces_forgotten, 0, "1 was never remembered");
    // Slot 902: the key learned again (2 reads), 3 pending: no probe.
    assert_eq!(tick(&mut review, &fx, 902), (1, 2, 0));
    assert_eq!(review.seed_probes, 1);
    // Slot 903: nonce 3 tried (3 reads), accepted over its own snapshot,
    // remembered.
    let t = tick(&mut review, &fx, 903);
    assert_last_is_candidate(&review);
    assert_eq!(t, (1, 3, 1));
    assert_eq!(review.resolve_candidates, 1);
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, REGION), Some(3));
    assert!(review.pending_nonces(RESOLVE_BELL, REGION).is_empty());
    assert_eq!(
        review.status()["recent"][0]["candidate"]["facts"]["seed_nonce"],
        3
    );
    // Slot 1,000: the remembered cache no longer matches THE anchor (3
    // reads): forgotten, cooling down; nothing pending; blocked.
    fx.caches.insert(3, bad(3));
    assert_eq!(tick(&mut review, &fx, 1_000), (1, 3, 0));
    assert_eq!(review.seed_nonces_forgotten, 1);
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, REGION), None);
    assert_eq!(
        review.bad_nonces(RESOLVE_BELL, REGION),
        vec![(1, 901 + cooldown), (3, 1_000 + cooldown)]
    );
    let r = &review.status()["recent"][0];
    assert_eq!(r["outcome"], "blocked");
    assert!(r["block"].as_str().unwrap().starts_with("SeedNotReady"));
    // Slot 1,100 (the refresh): the key again (2), a probe (4) finds 1 and
    // 3, both cooling: nothing tried, blocked; no snapshot. The key stays
    // learned (nothing was refused).
    assert_eq!(tick(&mut review, &fx, 1_100), (1, 6, 0));
    assert_eq!(review.seed_probes, 2);
    assert_eq!(review.pending_nonces(RESOLVE_BELL, REGION), vec![1, 3]);
    assert!(review.status()["recent"][0]["block"]
        .as_str()
        .unwrap()
        .starts_with("SeedNonceUnknown"));
    // The cache at nonce 1 is corrected on chain. Slot 1,200 (past nonce
    // 1's cooldown, not 3's): the key is known and 1 is pending and no
    // longer cooling, so the **same** nonce 1 is tried again (3 reads) —
    // no probe — and accepted over its own snapshot; its cooldown entry
    // cleared, 3's kept.
    fx.caches.insert(1, good(1));
    assert!(1_200 >= 901 + cooldown && 1_200 < 1_000 + cooldown);
    let t = tick(&mut review, &fx, 1_200);
    assert_last_is_candidate(&review);
    assert_eq!(t, (1, 3, 1));
    assert_eq!(review.seed_probes, 2);
    assert_eq!(review.resolve_candidates, 2);
    assert_eq!(review.remembered_nonce(RESOLVE_BELL, REGION), Some(1));
    assert_eq!(
        review.bad_nonces(RESOLVE_BELL, REGION),
        vec![(3, 1_000 + cooldown)]
    );
    assert_eq!(
        review.status()["recent"][0]["candidate"]["facts"]["seed_nonce"],
        1
    );
    assert_eq!(review.status()["resolve"]["bad_nonces"], 1);
    assert_eq!(engine.pending_len(), 0);
}

// ------------------------------------------------------------ content sealing

/// One `getMultipleAccounts` response for `keys ‖ Clock` written as literal
/// JSON from `accounts` (the Clock's slot is the context slot), parsed by
/// the snapshot parser itself. No rent (settle creates nothing).
fn snapshot_json(
    accounts: &BTreeMap<Address, Option<Account>>,
    keys: &[Address],
    clock: ClockSysvar,
) -> Value {
    snapshot_json_rent(accounts, keys, clock, None)
}
/// [`snapshot_json`] with the Rent sysvar appended after the Clock when
/// `rent` is given (the shape a `with_rent` request is answered in).
fn snapshot_json_rent(
    accounts: &BTreeMap<Address, Option<Account>>,
    keys: &[Address],
    clock: ClockSysvar,
    rent: Option<RentSysvar>,
) -> Value {
    let mut value: Vec<Value> = keys
        .iter()
        .map(|k| match accounts.get(k).cloned().flatten() {
            Some(a) => account_json(&a),
            None => Value::Null,
        })
        .collect();
    value.push(account_json(&Account {
        lamports: 1,
        data: clock.encode().to_vec(),
        owner: sysvar_owner(),
        executable: false,
    }));
    if let Some(r) = rent {
        value.push(account_json(&Account {
            lamports: 1,
            data: r.encode().to_vec(),
            owner: sysvar_owner(),
            executable: false,
        }));
    }
    json!({"context": {"slot": clock.slot}, "value": value})
}
fn snapshot_of(
    accounts: &BTreeMap<Address, Option<Account>>,
    keys: &[Address],
    clock: ClockSysvar,
    min_slot: u64,
) -> Snapshot {
    parse_snapshot_response(&snapshot_json(accounts, keys, clock), keys, false, min_slot).unwrap()
}
/// [`snapshot_of`] with the Rent sysvar (`RENT_FIXTURE`) in the response.
fn snapshot_of_rent(
    accounts: &BTreeMap<Address, Option<Account>>,
    keys: &[Address],
    clock: ClockSysvar,
    min_slot: u64,
) -> Snapshot {
    parse_snapshot_response(
        &snapshot_json_rent(accounts, keys, clock, Some(RENT_FIXTURE)),
        keys,
        true,
        min_slot,
    )
    .unwrap()
}

/// What a coherent settle candidate loses when any public field differs
/// from what the planner produced, over reads that still verify.
fn lost_everything(label: &str, m: &Candidate, reads: &Reads, open: &EngineView) {
    assert!(
        reads.coherent_snapshot().is_some(),
        "{label}: the reads still verify"
    );
    assert!(!m.coherent(), "{label}: coherent");
    assert!(m.snapshot().is_none(), "{label}: snapshot");
    assert_eq!(m.describe()["coherent"], false, "{label}: describe");
    let n = widefees::duty_needs(m, reads).unwrap();
    assert!(
        matches!(n.rent_lamports, Known::Unchecked(_)),
        "{label}: rent {:?}",
        n.rent_lamports
    );
    assert!(
        matches!(n.funding, Funding::Unknown(_)),
        "{label}: funding {:?}",
        n.funding
    );
    assert_eq!(n.snapshot_digest, None, "{label}: digest");
    let a = widereview::review_candidate(m, reads, open);
    assert!(a.snapshot.is_none(), "{label}: assessment snapshot");
    assert!(
        a.review.denials.contains(&Deny::NoCoherentSnapshot),
        "{label}: denial"
    );
    assert!(
        a.review.denials.contains(&Deny::FundingUnknown),
        "{label}: funding denial"
    );
    assert!(!a.review.admitted, "{label}: admitted");
}

#[test]
fn a_mutated_settle_candidate_loses_its_snapshot_fee_bound_and_review() {
    let fx = SettleFx::new(home());
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    let clock = clock_at(1_790_444_847);
    let mut accounts = fx.reads().accounts;
    let mut keys: Vec<Address> = accounts.keys().copied().collect();
    keys.push(payer());
    accounts.insert(
        payer(),
        Some(Account {
            lamports: 1_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let snap = snapshot_of(&accounts, &keys, clock, 7);
    let reads = snap.reads();
    assert_eq!((reads.min_slot, reads.clock), (7, Some(clock)));
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert_eq!(c.instruction, fx.expected_instruction());
    assert!(c.coherent());
    assert_eq!(c.snapshot().map(|m| m.digest()), Some(snap.meta().digest()));
    assert_eq!((c.min_slot, c.observed_clock), (7, Some(clock)));
    assert!(!c.status_promoted_by_clock);
    // Bound: nothing created, rent zero, the one-signature base fee met by
    // the payer at the context slot; still never admitted.
    let pristine = widefees::duty_needs(&c, &reads).unwrap();
    assert!(pristine.creates.is_empty());
    assert_eq!(pristine.rent_lamports, Known::Known(0));
    assert_eq!(pristine.required_lower_bound, Known::Known(5_000));
    assert_eq!(
        pristine.funding,
        Funding::MetLowerBound {
            payer_lamports: 1_000_000,
            required: 5_000
        }
    );
    assert_eq!(pristine.snapshot_digest, Some(snap.meta().digest()));
    let a = widereview::review_candidate(&c, &reads, &open);
    assert_eq!(
        a.snapshot.as_ref().map(|m| m.digest()),
        Some(snap.meta().digest())
    );
    assert!(!a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(!a.review.denials.contains(&Deny::FundingUnknown));
    assert!(a.review.denials.contains(&Deny::SnapshotCurrencyUnknown));
    assert!(!a.review.admitted);
    // An untouched clone is the same candidate.
    let same = c.clone();
    assert!(same.coherent());
    assert_eq!(widefees::duty_needs(&same, &reads).unwrap(), pristine);
    // The duty's facts: any field.
    let mut m = c.clone();
    match &mut m.duty {
        Duty::SettleDeparture(f) => f.predicted_destroyed = !f.predicted_destroyed,
        Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("predicted_destroyed", &m, &reads, &open);
    let mut m = c.clone();
    match &mut m.duty {
        Duty::SettleDeparture(f) => f.troops_after_milli += 1,
        Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("troops_after_milli", &m, &reads, &open);
    let mut m = c.clone();
    match &mut m.duty {
        Duty::SettleDeparture(f) => f.origin_is_home = !f.origin_is_home,
        Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("origin_is_home", &m, &reads, &open);
    let mut m = c.clone();
    match &mut m.duty {
        Duty::SettleDeparture(f) => f.entry_index += 1,
        Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("entry_index", &m, &reads, &open);
    // The duty's kind.
    let mut m = c.clone();
    m.duty = Duty::Return(wideduty::ReturnFacts {
        standing: home(),
        holding: host().holding_ref(),
        holding_present: true,
        live_gen: Some(GEN),
        foreign: false,
        picks: vec![],
        skipped_in_transit: 0,
    });
    lost_everything("duty kind", &m, &reads, &open);
    // The payer.
    let mut m = c.clone();
    m.payer = actor();
    lost_everything("payer", &m, &reads, &open);
    // The instruction: program, data, keys, flags, cardinality, order.
    let mut m = c.clone();
    m.instruction.program_id = actor();
    lost_everything("program_id", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.data[0] ^= 1;
    lost_everything("data[0]", &m, &reads, &open);
    let mut m = c.clone();
    let last = m.instruction.data.len() - 1;
    m.instruction.data[last] ^= 1;
    lost_everything("data[last]", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.data.push(0);
    lost_everything("data longer", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[0].pubkey = actor();
    lost_everything("accounts[0].pubkey", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[0].is_signer = false;
    lost_everything("accounts[0].is_signer", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[1].is_writable = true;
    lost_everything("accounts[1].is_writable", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts.pop();
    lost_everything("accounts fewer", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction
        .accounts
        .push(AccountMeta::new_readonly(actor(), false));
    lost_everything("accounts more", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts.swap(2, 3);
    lost_everything("accounts reordered", &m, &reads, &open);
    // The observed metadata.
    let mut m = c.clone();
    m.min_slot = 8;
    lost_everything("min_slot", &m, &reads, &open);
    let mut m = c.clone();
    m.observed_clock = Some(clock_at(1_790_444_848));
    lost_everything("observed_clock", &m, &reads, &open);
    let mut m = c.clone();
    m.observed_clock = None;
    lost_everything("observed_clock dropped", &m, &reads, &open);
    let mut m = c.clone();
    m.status_promoted_by_clock = true;
    lost_everything("status_promoted_by_clock", &m, &reads, &open);
    // The always-false flags are content too; the review never read them
    // and still denies the signer.
    let mut m = c.clone();
    m.signed = true;
    lost_everything("signed", &m, &reads, &open);
    let mut m = c.clone();
    m.automatic_send = true;
    lost_everything("automatic_send", &m, &reads, &open);
    let mut m = c.clone();
    m.signed = true;
    m.automatic_send = true;
    lost_everything("both flags", &m, &reads, &open);
    let a = widereview::review_candidate(&m, &reads, &open);
    assert!(!a.review.admitted);
    assert!(a.review.denials.contains(&Deny::SignerAbsent));
    // A/B: the same plan over another response (the payer at five
    // lamports): each coherent over its own reads, neither over the
    // other's; the other's number is never borrowed.
    let mut accounts_b = accounts.clone();
    accounts_b.insert(
        payer(),
        Some(Account {
            lamports: 5,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let snap_b = snapshot_of(&accounts_b, &keys, clock, 7);
    let reads_b = snap_b.reads();
    assert_ne!(snap.meta().digest(), snap_b.meta().digest());
    let cb = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads_b,
    ))
    .unwrap();
    assert!(cb.coherent());
    assert_eq!(
        (cb.duty.clone(), cb.instruction.clone()),
        (c.duty.clone(), c.instruction.clone())
    );
    assert_eq!(
        widefees::duty_needs(&cb, &reads_b).unwrap().funding,
        Funding::Unmet {
            payer_lamports: 5,
            required: 5_000,
            short: 4_995
        }
    );
    for (label, cand, other) in [("A over B", &c, &reads_b), ("B over A", &cb, &reads)] {
        let n = widefees::duty_needs(cand, other).unwrap();
        assert!(matches!(n.funding, Funding::Unknown(_)), "{label}");
        assert_eq!(n.snapshot_digest, None, "{label}");
        let a = widereview::review_candidate(cand, other, &open);
        assert!(a.snapshot.is_none(), "{label}");
        assert!(
            a.review.denials.contains(&Deny::NoCoherentSnapshot),
            "{label}"
        );
        assert!(a.review.denials.contains(&Deny::FundingUnknown), "{label}");
        assert!(!a.review.denials.contains(&Deny::FundingUnmet), "{label}");
    }
    // A mutated B over A's reads binds nothing either.
    let mut mb = cb.clone();
    mb.payer = actor();
    assert!(!mb.coherent());
    assert!(widereview::review_candidate(&mb, &reads, &open)
        .review
        .denials
        .contains(&Deny::NoCoherentSnapshot));
    // The pristine pair still binds: nothing above touched `c` or `reads`.
    assert!(c.coherent());
    assert_eq!(widefees::duty_needs(&c, &reads).unwrap(), pristine);
}

/// `w` with byte `i` flipped: another world whose `Debug` (the first four
/// bytes) is the same when `i ≥ 4`.
fn flip_world(w: WorldId, i: usize) -> WorldId {
    let mut b = *w.as_bytes();
    b[i] ^= 1;
    WorldId::new(b).unwrap()
}
fn rekey(k: ProvinceKey, i: usize) -> ProvinceKey {
    ProvinceKey::new(flip_world(k.world(), i), k.coord())
}
fn rehost(h: WideHostRef, i: usize) -> WideHostRef {
    WideHostRef::new(rekey(h.key(), i), h.site(), h.gen(), h.seq()).unwrap()
}

#[test]
fn world_bytes_past_the_debug_prefix_are_candidate_content() {
    // `WorldId`'s Debug prints four of its 32 bytes: two identities that
    // differ only later print the same. The content digest hashes the
    // full ABI bytes, never Debug output.
    assert_eq!(format!("{:?}", rehost(host(), 5)), format!("{:?}", host()));
    assert_ne!(rehost(host(), 5), host());
    assert_eq!(format!("{:?}", rekey(home(), 31)), format!("{:?}", home()));
    assert_ne!(rekey(home(), 31).to_bytes(), home().to_bytes());
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    let clock = clock_at(1_790_444_847);
    let funded = Some(Account {
        lamports: 1_000_000,
        data: vec![],
        owner: fclient::addr::system_program(),
        executable: false,
    });
    // A coherent settle candidate.
    let fx = SettleFx::new(home());
    let mut accounts = fx.reads().accounts;
    let mut keys: Vec<Address> = accounts.keys().copied().collect();
    keys.push(payer());
    accounts.insert(payer(), funded.clone());
    let snap = snapshot_of(&accounts, &keys, clock, 7);
    let reads = snap.reads();
    let c = done(wideduty::plan_settle_departure(
        &dscope(),
        payer(),
        host(),
        SLOT,
        &reads,
    ))
    .unwrap();
    assert!(c.coherent());
    assert!(matches!(
        widefees::duty_needs(&c, &reads).unwrap().funding,
        Funding::MetLowerBound { .. }
    ));
    // The host's world, bytes 4, 5, 17 and 31; the origin's world, bytes 4
    // and 31. The instruction is left exactly as planned.
    for i in [4usize, 5, 17, 31] {
        let mut m = c.clone();
        match &mut m.duty {
            Duty::SettleDeparture(f) => f.host = rehost(f.host, i),
            Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
                unreachable!()
            }
        }
        assert_eq!(m.instruction, c.instruction);
        assert_eq!(
            format!("{:?}", m.duty),
            format!("{:?}", c.duty),
            "Debug cannot tell"
        );
        lost_everything(&format!("settle host world[{i}]"), &m, &reads, &open);
    }
    for i in [4usize, 31] {
        let mut m = c.clone();
        match &mut m.duty {
            Duty::SettleDeparture(f) => f.origin = rekey(f.origin, i),
            Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
                unreachable!()
            }
        }
        assert_eq!(m.instruction, c.instruction);
        assert_eq!(
            format!("{:?}", m.duty),
            format!("{:?}", c.duty),
            "Debug cannot tell"
        );
        lost_everything(&format!("settle origin world[{i}]"), &m, &reads, &open);
    }
    // A coherent return candidate (one host of the home holding standing
    // in `away`, the tenth account present).
    let rfx = ReturnFx::new(away(), &[host()]);
    let mut accounts = rfx.reads().accounts;
    let mut keys: Vec<Address> = accounts.keys().copied().collect();
    keys.push(payer());
    accounts.insert(payer(), funded);
    let snap_r = snapshot_of(&accounts, &keys, clock, 7);
    let reads_r = snap_r.reads();
    let r = done(wideduty::plan_return(
        &dscope(),
        payer(),
        away(),
        host().holding_ref(),
        &reads_r,
    ))
    .unwrap();
    assert!(r.coherent());
    assert_eq!(return_facts(&r).picks.len(), 1);
    assert!(matches!(
        widefees::duty_needs(&r, &reads_r).unwrap().funding,
        Funding::MetLowerBound { .. }
    ));
    // The standing's world, the holding reference's world, the pick's
    // host's world — each past the Debug prefix, instruction unchanged.
    for i in [4usize, 31] {
        let mut m = r.clone();
        match &mut m.duty {
            Duty::Return(f) => f.standing = rekey(f.standing, i),
            Duty::SettleDeparture(_)
            | Duty::Gather(_)
            | Duty::Resolve(_)
            | Duty::SettleTransit(_) => {
                unreachable!()
            }
        }
        assert_eq!(m.instruction, r.instruction);
        assert_eq!(
            format!("{:?}", m.duty),
            format!("{:?}", r.duty),
            "Debug cannot tell"
        );
        lost_everything(&format!("return standing world[{i}]"), &m, &reads_r, &open);
        let mut m = r.clone();
        match &mut m.duty {
            Duty::Return(f) => f.holding = rehost(f.holding, i),
            Duty::SettleDeparture(_)
            | Duty::Gather(_)
            | Duty::Resolve(_)
            | Duty::SettleTransit(_) => {
                unreachable!()
            }
        }
        assert_eq!(m.instruction, r.instruction);
        assert_eq!(
            format!("{:?}", m.duty),
            format!("{:?}", r.duty),
            "Debug cannot tell"
        );
        lost_everything(&format!("return holding world[{i}]"), &m, &reads_r, &open);
        let mut m = r.clone();
        match &mut m.duty {
            Duty::Return(f) => f.picks[0].host = rehost(f.picks[0].host, i),
            Duty::SettleDeparture(_)
            | Duty::Gather(_)
            | Duty::Resolve(_)
            | Duty::SettleTransit(_) => {
                unreachable!()
            }
        }
        assert_eq!(m.instruction, r.instruction);
        assert_eq!(
            format!("{:?}", m.duty),
            format!("{:?}", r.duty),
            "Debug cannot tell"
        );
        lost_everything(&format!("return pick host world[{i}]"), &m, &reads_r, &open);
    }
    // Every other return fact and the flags, once each.
    let mut m = r.clone();
    match &mut m.duty {
        Duty::Return(f) => f.live_gen = None,
        Duty::SettleDeparture(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("return live_gen", &m, &reads_r, &open);
    let mut m = r.clone();
    match &mut m.duty {
        Duty::Return(f) => f.picks[0].credited = !f.picks[0].credited,
        Duty::SettleDeparture(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("return pick credited", &m, &reads_r, &open);
    let mut m = r.clone();
    match &mut m.duty {
        Duty::Return(f) => f.picks.clear(),
        Duty::SettleDeparture(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("return picks cleared", &m, &reads_r, &open);
    let mut m = r.clone();
    match &mut m.duty {
        Duty::Return(f) => f.skipped_in_transit += 1,
        Duty::SettleDeparture(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    lost_everything("return skipped_in_transit", &m, &reads_r, &open);
    let mut m = r.clone();
    m.signed = true;
    lost_everything("return signed", &m, &reads_r, &open);
    let mut m = r.clone();
    m.automatic_send = true;
    lost_everything("return automatic_send", &m, &reads_r, &open);
    // The world byte flipped back is the planner's candidate again: the
    // digest is of the bytes, not of the edit.
    let mut m = c.clone();
    match &mut m.duty {
        Duty::SettleDeparture(f) => f.host = rehost(rehost(f.host, 9), 9),
        Duty::Return(_) | Duty::Gather(_) | Duty::Resolve(_) | Duty::SettleTransit(_) => {
            unreachable!()
        }
    }
    assert!(m.coherent());
    assert!(c.coherent() && r.coherent());
}
