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
use fclient::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};
use fclient::tx::{self, TxBudget};
use fclient::{Hash, Transaction};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::{wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::header;
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::world::season as SL;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::layout::province::{province as PV2, site as SM};
use frontier_abi::world_index::event::{self as wev, encode, WideEntity, WideKind, WideLink};
use frontier_abi::world_index::wide_ix::{
    self as wix, Depart, ResidentAct, Return, SettleDeparture,
};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, roster as wro, seal as wseal, MarchEvent, MarchState,
    ProvinceKey, TileAddress, WideCoord, WideHolding, WideHostRef, WideProvince, WideRoster,
    WideTransit, WorldId, HOST_IDENTITY_FULL_REF_V1, WIDE_SEAL_LEN,
};
use keeper_core::wideduty::{self, Block, Candidate, Deployment, Duty, Reads, Step, RETURN_MAX};
use keeper_core::wideindex::{Limits, Scope as IndexScope, WideBatch, WideDiscovery};
use keeper_core::wideproof::{depart_proof, ProofScope, Unavailable};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

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
    let p = WideProvince {
        season_id: SEASON_ID,
        world: k.world(),
        coord: k.coord(),
        wedge: k.coord().wedge().unwrap(),
        region: 0,
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
    assert!(!c.signed && !c.automatic_send && !c.coherent);
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
    assert!(!c.coherent);
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
    assert!(!c.signed && !c.automatic_send && !c.coherent);
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
    assert!(!c.coherent, "a separately observed clock is never coherent");
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
