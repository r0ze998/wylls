//! The wide Reveal planner and the engine admission review over **literal**
//! public data: literal addresses, a literal (labelled) `DepartProof`
//! fixture — not extracted from a feed record and not a live proof — a
//! literal seal and salt, account fixtures written with the ABI's own
//! encoders, the workspace's shipped **public quicknet rounds**
//! (`fclient/fixtures/quicknet`, SP-V2: real drand signatures, verified
//! under the published key — no signature is produced here), and a fake
//! `ChainPort` that counts and refuses `simulate` and `send`. No key, no
//! signing, no generator, no chain. Run with
//! `cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_reveal`.
#![cfg(feature = "wide-world-experimental")]

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use fclient::beacon::{self, FixtureDrand};
use fclient::budgets::Budgets;
use fclient::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};
use fclient::Hash;
use frontier_abi::addr::{archive_part_of, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use frontier_abi::layout::beacon::{anchor_archive as AA, bell_anchor as BA};
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::province::site as SM;
use frontier_abi::layout::world::{beacon_log as BL, season as SL};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::world_index::wide_ix::{self as wix, Reveal};
use frontier_abi::world_index::{
    arrival as wa, holding as wh, land as wl, march as wm, seal as wseal, MarchEvent, MarchState,
    ProvinceKey, TileAddress, WideCoord, WideHolding, WideHostRef, WidePlain, WideProvince,
    WideTile, WideTransit, WorldId, HOST_IDENTITY_FULL_REF_V1, WIDE_PLAIN_LEN, WIDE_SEAL_LEN,
};
use keeper_core::engine::{Engine, EngineParams};
use keeper_core::wideduty::{self, Block, Deployment, Reads, Step};
use keeper_core::wideproof::{DepartProof, Provenance};
use keeper_core::widereveal::{self, Crypto, Opening, Publication, RevealCandidate, UNVERIFIED};
use keeper_core::widereview::{self, Deny, EngineView, Subject, HARD_DENIALS};
use permutation_rules::frontier::beacon::{bell_start, first_round_from};
use permutation_rules::frontier::seal::encode_path;
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
const ORIGIN_TILE: u8 = 5;
const REGION: u8 = 2;
const REVEAL_WINDOW: u32 = 1_200;
const SALT: [u8; 32] = [0x44; 32];
const RULESET: [u8; 32] = [0x77; 32];
const WIDE_VERSION: u16 =
    frontier_abi::v2::presets::PROGRAM_VERSION_S1 | wix::WIDE_EXPERIMENTAL_VERSION_BIT;

/// The shipped public quicknet round the fixture Season is laid out
/// around: the lowest round of `fclient/fixtures/quicknet`, with its real
/// signature, verified under the published key by `FixtureDrand::load`.
fn vector() -> (u64, [u8; 48]) {
    static VECTOR: std::sync::OnceLock<(u64, [u8; 48])> = std::sync::OnceLock::new();
    *VECTOR.get_or_init(|| {
        let f = FixtureDrand::load(&beacon::fixture_dir(), beacon::quicknet_info())
            .expect("the SP-V2 quicknet rounds ship with fclient");
        let (r, b) = f.rounds.iter().next().expect("at least one round");
        (*r, b.sig48)
    })
}
fn pk96() -> [u8; 96] {
    beacon::quicknet_info().public_key
}
/// The Season's genesis chosen so that `T(ARRIVE_BELL)` is exactly the
/// vector's round: `first_round_from(g, 3, bell_end) = R` ⇔
/// `bell_end = g + (R − 1) × 3`.
fn genesis_ts() -> i64 {
    let (r, _) = vector();
    beacon::QUICKNET_GENESIS + (r as i64 - 1) * beacon::QUICKNET_PERIOD as i64
        - (ARRIVE_BELL as i64 + 1) * 600
}
fn a_ts() -> i64 {
    bell_start(genesis_ts(), ARRIVE_BELL)
}
fn depart_ts() -> i64 {
    bell_start(genesis_ts(), DEPART_BELL) + 1
}
/// The seed round of the fixture window: `first_round_from(g, 3, A + W)`.
fn seed_round() -> u64 {
    first_round_from(
        beacon::QUICKNET_GENESIS,
        beacon::QUICKNET_PERIOD,
        a_ts() + REVEAL_WINDOW as i64,
    )
}
fn publication() -> Publication {
    let (round, sig48) = vector();
    Publication {
        round,
        sig48,
        pk96: pk96(),
    }
}

fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn season_pda() -> (Address, u8) {
    fclient::addr::season_pda(&program(), SEASON_ID)
}
fn scope() -> wideduty::Scope {
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
fn key(p: i64, q: i64) -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(p, q).unwrap())
}
fn home() -> ProvinceKey {
    key(129, 0)
}
fn away() -> ProvinceKey {
    key(129, -1)
}
fn host() -> WideHostRef {
    WideHostRef::new(home(), SITE, GEN, 7).unwrap()
}
/// Another host of the same holding (same Citizen).
fn host_b() -> WideHostRef {
    WideHostRef::new(home(), SITE, GEN, 8).unwrap()
}
/// A host of another holding (site 4, another Citizen).
fn host_c(seq: u32) -> WideHostRef {
    WideHostRef::new(home(), 4, GEN, seq).unwrap()
}
fn payer() -> Address {
    Address::new_from_array([0xA1; 32])
}
fn beneficiary() -> Address {
    Address::new_from_array([0xB1; 32])
}
fn citizen() -> [u8; 32] {
    [0xC1; 32]
}
fn other_citizen() -> [u8; 32] {
    [0xC2; 32]
}
fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}
fn origin() -> TileAddress {
    TileAddress::new(home(), ORIGIN_TILE).unwrap()
}
fn holding_addr() -> Address {
    addr(wh::holding_address(&ctx(), home().coord(), SITE))
}
fn transit_addr() -> Address {
    addr(wm::transit_address(
        &ctx(),
        &holding_addr().to_bytes(),
        SLOT,
    ))
}
fn province_addr(k: ProvinceKey) -> Address {
    addr(wl::province_address(&ctx(), k.coord()))
}
fn anchor_addr() -> Address {
    addr(ctx().bell_anchor(ARRIVE_BELL, REGION))
}
fn archive_addr() -> Address {
    addr(ctx().anchor_archive(REGION, archive_part_of(ARRIVE_BELL)))
}
fn log_addr() -> Address {
    addr(ctx().beacon_log(REGION))
}
fn inputs_addr() -> Address {
    addr(wa::clash_inputs_address(&ctx(), home(), ARRIVE_BELL))
}
fn day_addr() -> Address {
    addr(wa::arrival_day_address(
        &ctx(),
        home(),
        wa::day_of(ARRIVE_BELL),
    ))
}
fn slot_addr(i: u8) -> Address {
    addr(wa::arrival_slot_address(&ctx(), home(), ARRIVE_BELL, 0, i))
}

// ------------------------------------------------------------ the march

/// One committed step from the origin tile to a neighbour inside the
/// same province: the direction and the destination tile, found by the
/// ABI's own geometry (no hand-written coordinates).
fn one_step() -> (u8, u8) {
    let o = WideTile::of(origin());
    let ns = o.neighbors();
    for (d, n) in ns.iter().enumerate() {
        if let Some(n) = n {
            if n.province() == home() {
                return (d as u8, n.local());
            }
        }
    }
    panic!("a radius-4 province tile has a neighbour inside it");
}

fn plain_for(h: WideHostRef, arrive: u32) -> WidePlain {
    let (dir, dest_tile) = one_step();
    let (n, path) = encode_path(&[dir]).unwrap();
    WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host: h,
        arrive_bell: arrive,
        dest: home(),
        dest_tile,
        stance: 0,
        retreat_bps: 0,
        path_len: n,
        path,
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    }
}

/// A literal seal (the IBE block is not a real tlock block: nothing here
/// can open it) with the handler's flag syntax.
fn seal() -> [u8; WIDE_SEAL_LEN] {
    let mut s = [0x33u8; WIDE_SEAL_LEN];
    s[0] = 0x80;
    s
}

/// The commitment and root of `plain` under the literal salt and seal.
fn roots(plain: &[u8; WIDE_PLAIN_LEN]) -> ([u8; 32], [u8; 32]) {
    let c = wseal::commit(plain, &SALT);
    (c, wseal::seal_root(&c, &wseal::ct_hash(&seal())))
}

/// A **fixture** proof: literal, labelled, not extracted from a record.
fn proof_for(plain: &[u8; WIDE_PLAIN_LEN], arrive: u32) -> DepartProof {
    let (commit, root) = roots(plain);
    DepartProof {
        host: host(),
        standing: home(),
        transit_slot: SLOT,
        depart_bell: DEPART_BELL,
        arrive_bell: arrive,
        tip: TIP,
        commit,
        seal: seal(),
        seal_root: root,
        dep_mass_milli: TROOPS,
        march_stamina: 61,
        fee: 7_000,
        bond: 11_000,
        holding: holding_addr(),
        transit: transit_addr(),
        origin_province: province_addr(home()),
        roster: addr(frontier_abi::world_index::roster::roster_address(
            &ctx(),
            home(),
        )),
        act_wrapped: false,
        provenance: Provenance {
            seq: 11,
            slot: 1_011,
            signature: [0x51; 64],
            instruction_index: 3,
            signatures_verified: false,
            method: "test fixture: literal DepartProof, not extracted from a feed record",
        },
    }
}

// ------------------------------------------------------------ accounts

fn acct(data: Vec<u8>) -> Option<Account> {
    Some(Account {
        lamports: 1_000_000,
        data,
        owner: program(),
        executable: false,
    })
}

/// A Season on the real quicknet clock whose `T(ARRIVE_BELL)` is the
/// vector's round and whose key pin is the published quicknet key.
fn season_bytes(status: u8, end_bell: u32) -> Vec<u8> {
    let mut d = vec![0u8; SL::SIZE];
    assert!(wr_arr(&mut d, SL::HDR_MAGIC, &SL::MAGIC));
    assert!(wr_u64(&mut d, SL::SEASON_ID, SEASON_ID));
    assert!(wr_u16(&mut d, SL::LAYOUT_VERSION, 2));
    assert!(wr_u8(&mut d, SL::STATUS, status));
    assert!(wr_u8(&mut d, SL::BUMP, season_pda().1));
    assert!(wr_arr(&mut d, SL::RULESET_HASH, &RULESET));
    assert!(wr_u16(&mut d, SL::PROGRAM_VERSION, WIDE_VERSION));
    assert!(wr_u32(&mut d, SL::BELL_SECS, 600));
    assert!(wr_arr(&mut d, SL::GENESIS_TS, &genesis_ts().to_le_bytes()));
    assert!(wr_u32(&mut d, SL::END_BELL, end_bell));
    assert!(wr_arr(
        &mut d,
        SL::DRAND_GENESIS,
        &beacon::QUICKNET_GENESIS.to_le_bytes()
    ));
    assert!(wr_u32(&mut d, SL::DRAND_PERIOD, beacon::QUICKNET_PERIOD));
    assert!(wr_arr(
        &mut d,
        SL::QUICKNET_PK_HASH,
        &beacon::pk_hash(&pk96())
    ));
    assert!(wr_u32(&mut d, SL::REVEAL_WINDOW, REVEAL_WINDOW));
    assert!(wr_u32(&mut d, SL::WINDOW_FROM_BELL, u32::MAX));
    d
}

fn province_bytes(k: ProvinceKey, resolved_next: u32) -> Vec<u8> {
    let p = WideProvince {
        season_id: SEASON_ID,
        world: k.world(),
        coord: k.coord(),
        wedge: k.coord().wedge().unwrap(),
        region: REGION,
        opened_bell: 1,
        readiness: wl::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x5e; 32],
        funded_lamports: 0,
    };
    let mut d = vec![0u8; wl::province::SIZE];
    p.write_identity(&mut d).unwrap();
    assert!(wr_u32(&mut d, PV::RESOLVED_NEXT, resolved_next));
    assert!(wr_u64(&mut d, PV::PASSABLE_MASK, (1u64 << 61) - 1));
    d
}

fn holding_bytes() -> Vec<u8> {
    let h = WideHolding {
        season_id: SEASON_ID,
        world: world(),
        coord: home().coord(),
        site: SITE,
        gen: GEN,
        slot: 2,
        owner_citizen: citizen(),
        host_identity: HOST_IDENTITY_FULL_REF_V1,
        open_transits: 1,
    };
    let mut d = vec![0u8; wh::wide_holding::SIZE];
    h.write_identity(&mut d).unwrap();
    d[H::STATE] = H::STATE_FINAL;
    d
}

#[allow(clippy::too_many_arguments)]
fn transit_full(
    h: WideHostRef,
    origin: TileAddress,
    depart_bell: u32,
    arrive: u32,
    root: [u8; 32],
    depart_ts: i64,
    dep_mass: u32,
    stamina: u16,
    tip: u64,
) -> WideTransit {
    WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        h,
        2,
        0,
        origin,
        depart_bell,
        arrive,
        depart_ts,
        dep_mass,
        stamina,
        0,
        root,
        tip,
        0,
        payer().to_bytes(),
    )
    .unwrap()
}
fn transit_with(h: WideHostRef, arrive: u32, root: [u8; 32], depart_ts: i64) -> WideTransit {
    transit_full(
        h,
        origin(),
        DEPART_BELL,
        arrive,
        root,
        depart_ts,
        TROOPS,
        61,
        TIP,
    )
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
fn log_bytes(region: u8, latest: u64) -> Vec<u8> {
    let mut d = vec![0u8; BL::SIZE];
    assert!(wr_arr(&mut d, BL::HDR_MAGIC, &BL::MAGIC));
    assert!(wr_u64(&mut d, BL::SEASON_ID, SEASON_ID));
    assert!(wr_u8(&mut d, BL::REGION, region));
    assert!(wr_u64(&mut d, BL::LATEST_ROUND, latest));
    d
}
fn archive_bytes() -> Vec<u8> {
    let mut d = vec![0u8; AA::SIZE];
    assert!(wr_arr(&mut d, AA::HDR_MAGIC, &AA::MAGIC));
    assert!(wr_u64(&mut d, AA::SEASON_ID, SEASON_ID));
    assert!(wr_u8(&mut d, AA::REGION, REGION));
    assert!(wr_u32(&mut d, AA::PART, archive_part_of(ARRIVE_BELL)));
    d
}
fn slot_bytes(i: u8, h: WideHostRef, cit: [u8; 32], dep_mass: u32) -> Vec<u8> {
    let s = wa::WideArrivalSlot {
        season_id: SEASON_ID,
        dest: home(),
        bell: ARRIVE_BELL,
        faction: 0,
        i,
        transit_slot: 0,
        host: h,
        citizen: cit,
        unit: 2,
        stance: 0,
        tile: 1,
        retreat_bps: 0,
        dealt_bps: 0,
        dep_mass,
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
fn day_bytes(bit_set: bool) -> Vec<u8> {
    let mut rec = wa::WideArrivalDay::new(SEASON_ID, home(), wa::day_of(ARRIVE_BELL), [0xB4; 32]);
    if bit_set {
        assert!(rec.set(ARRIVE_BELL));
    }
    let mut d = vec![0u8; wa::wide_arrival_day::SIZE];
    rec.write(&mut d).unwrap();
    d
}
fn clock_at(ts: i64) -> ClockSysvar {
    ClockSysvar {
        slot: 900,
        unix_timestamp: ts,
        ..ClockSysvar::default()
    }
}

/// Every account a reveal of the fixture march reads, revealable: THE
/// anchor present at `A = bell start` with the vector's round, the log
/// below the seed round, no inputs, no day, no slots, the clock ten
/// seconds after `A`, the vector's publication.
struct Fx {
    plain: [u8; WIDE_PLAIN_LEN],
    proof: DepartProof,
    opening: Opening,
    publication: Option<Publication>,
    season: Vec<u8>,
    holding: Vec<u8>,
    transit: Option<Vec<u8>>,
    dest: Vec<u8>,
    anchor: Option<Vec<u8>>,
    archive: Option<Vec<u8>>,
    log: Option<Vec<u8>>,
    inputs: Option<Vec<u8>>,
    day: Option<Vec<u8>>,
    slots: [Option<Vec<u8>>; 4],
    clock: Option<ClockSysvar>,
}
impl Fx {
    fn new() -> Fx {
        Fx::with_plain(plain_for(host(), ARRIVE_BELL), ARRIVE_BELL)
    }
    /// A fixture whose transit record and proof commit to `plain`.
    fn with_plain(pt: WidePlain, arrive: u32) -> Fx {
        let plain = wseal::pack(&pt);
        let proof = proof_for(&plain, arrive);
        let t = transit_with(host(), arrive, proof.seal_root, depart_ts());
        let (round, _) = vector();
        Fx {
            plain,
            proof,
            opening: Opening::Supplied { plain, salt: SALT },
            publication: Some(publication()),
            season: season_bytes(SL::STATUS_RUNNING, 10_000),
            holding: holding_bytes(),
            transit: Some(t.to_bytes().to_vec()),
            dest: province_bytes(home(), ARRIVE_BELL),
            anchor: Some(anchor_bytes(ARRIVE_BELL, REGION, a_ts(), round)),
            archive: None,
            log: Some(log_bytes(REGION, round - 1)),
            inputs: None,
            day: None,
            slots: [None, None, None, None],
            clock: Some(clock_at(a_ts() + 10)),
        }
    }
    fn reads(&self) -> Reads {
        let mut r = Reads::new(0);
        r.clock = self.clock;
        let mut v = vec![
            (season_pda().0, acct(self.season.clone())),
            (holding_addr(), acct(self.holding.clone())),
            (transit_addr(), self.transit.clone().and_then(acct)),
            (province_addr(home()), acct(self.dest.clone())),
            (anchor_addr(), self.anchor.clone().and_then(acct)),
            (archive_addr(), self.archive.clone().and_then(acct)),
            (log_addr(), self.log.clone().and_then(acct)),
            (inputs_addr(), self.inputs.clone().and_then(acct)),
            (day_addr(), self.day.clone().and_then(acct)),
        ];
        for (i, s) in self.slots.iter().enumerate() {
            v.push((slot_addr(i as u8), s.clone().and_then(acct)));
        }
        r.accounts = v.into_iter().collect();
        r
    }
    fn plan(&self) -> Result<RevealCandidate, Block> {
        match widereveal::plan_reveal(
            &scope(),
            payer(),
            beneficiary(),
            &self.proof,
            Some(&self.opening),
            self.publication.as_ref(),
            &self.reads(),
        ) {
            Step::Done(r) => r,
            Step::Need(a) => panic!("unexpected read request: {a:?}"),
        }
    }
    fn expected_accounts(&self, target_i: u8, day_writable: bool) -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new(payer(), true),
            AccountMeta::new_readonly(season_pda().0, false),
            AccountMeta::new_readonly(holding_addr(), false),
            AccountMeta::new_readonly(transit_addr(), false),
            AccountMeta::new_readonly(anchor_addr(), false),
            AccountMeta::new_readonly(archive_addr(), false),
            AccountMeta::new_readonly(log_addr(), false),
            AccountMeta::new_readonly(inputs_addr(), false),
            AccountMeta::new_readonly(province_addr(home()), false),
            AccountMeta {
                pubkey: day_addr(),
                is_signer: false,
                is_writable: day_writable,
            },
        ];
        for i in 0..4u8 {
            v.push(AccountMeta {
                pubkey: slot_addr(i),
                is_signer: false,
                is_writable: i == target_i,
            });
        }
        v.push(AccountMeta::new_readonly(
            fclient::addr::instructions_sysvar(),
            false,
        ));
        v.push(AccountMeta::new_readonly(
            fclient::addr::system_program(),
            false,
        ));
        v
    }
    fn expected_data(&self, target_i: u8) -> Vec<u8> {
        Reveal {
            transit_slot: SLOT,
            target_i,
            plain: self.plain,
            salt: SALT,
            ct_hash: wseal::ct_hash(&seal()),
            beneficiary: beneficiary().to_bytes(),
        }
        .to_bytes()
        .to_vec()
    }
}

fn blocked(r: Result<RevealCandidate, Block>) -> Result<(), Block> {
    r.map(|_| ())
}

// ------------------------------------------------------------ tests

#[test]
fn the_fixture_season_puts_the_vectors_round_at_t_of_the_arrival_bell() {
    // The arithmetic the fixture rests on, checked with fclient's own
    // clock: `T(ARRIVE_BELL)` of the fixture Season is the vector's round,
    // and the vector's signature verifies under the published key.
    let (round, sig) = vector();
    let s = fclient::decode::Season::decode(&season_bytes(SL::STATUS_RUNNING, 10_000)).unwrap();
    let clock = fclient::clock::SeasonClock::from_season(&s);
    assert_eq!(clock.tlock_round(ARRIVE_BELL), round);
    assert_eq!(s.quicknet_pk_hash, beacon::pk_hash(&pk96()));
    assert!(beacon::verify(round, &sig, &pk96()));
    assert!(!beacon::verify(round + 1, &sig, &pk96()));
    assert!(
        round - 1 < seed_round(),
        "the fixture log stays below the seed round"
    );
}

#[test]
fn reveal_plan_reads_in_rounds_builds_the_exact_accounts_and_labels_a_supplied_opening() {
    let fx = Fx::new();
    let pb = publication();
    // Round 1: the Season, the holding, the transit.
    let mut reads = Reads::new(0);
    reads.clock = fx.clock;
    let s = widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        &reads,
    );
    assert_eq!(
        s,
        Step::Need(vec![season_pda().0, holding_addr(), transit_addr()])
    );
    let full = fx.reads();
    for a in [season_pda().0, holding_addr(), transit_addr()] {
        reads.accounts.insert(a, full.accounts[&a].clone());
    }
    // Round 2: the destination the plaintext names.
    let s = widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        &reads,
    );
    assert_eq!(s, Step::Need(vec![province_addr(home())]));
    reads.accounts.insert(
        province_addr(home()),
        full.accounts[&province_addr(home())].clone(),
    );
    // Round 3: the anchor, archive, log, inputs, day and the four slots
    // (no path province: the one step stays in the destination).
    let s = widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        &reads,
    );
    let mut want = vec![
        anchor_addr(),
        archive_addr(),
        log_addr(),
        inputs_addr(),
        day_addr(),
    ];
    want.extend((0..4u8).map(slot_addr));
    assert_eq!(s, Step::Need(want));
    let c = fx.plan().unwrap();
    assert_eq!(c.instruction.program_id, program());
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, true));
    assert_eq!(c.instruction.accounts.len(), wix::REVEAL_FIXED);
    assert_eq!(c.instruction.data, fx.expected_data(0));
    assert_eq!(c.instruction.data[0], wix::TAG_REVEAL);
    let f = &c.facts;
    assert_eq!(
        (f.host, f.transit_slot, f.arrive_bell, f.dest),
        (host(), SLOT, ARRIVE_BELL, home())
    );
    assert_eq!((f.region, f.target_i, f.displaced), (REGION, 0, None));
    assert!(!f.day_present && !f.day_bit_set);
    assert!(f.path_provinces.is_empty());
    assert!(f.travel_secs > 0);
    assert_eq!(
        f.crypto,
        Crypto::CommitmentOnly,
        "a matching root is not a verification"
    );
    assert_eq!(
        (f.publication.round, f.publication.signature_verified),
        (vector().0, true)
    );
    assert_eq!(f.publication.pk_hash, beacon::pk_hash(&pk96()));
    assert_eq!((f.window.a_ts, f.window.judged_at), (a_ts(), a_ts() + 10));
    assert_eq!(f.window.reveal_close, a_ts() + REVEAL_WINDOW as i64);
    assert_eq!(
        (f.window.seed_round, f.window.latest_round),
        (seed_round(), vector().0 - 1)
    );
    assert!(!f.source.signatures_verified);
    assert_eq!(f.unverified, UNVERIFIED.to_vec());
    assert!(f.budget_prefix_policy.contains("keeper policy"));
    assert!(!c.coherent && !c.signed && !c.automatic_send && !c.status_promoted_by_clock);
    let d = c.describe();
    assert_eq!(d["crypto"], "CommitmentOnly");
    assert_eq!(d["automatic_send"], false);
    assert_eq!(d["coherent"], false);
    assert_eq!(d["executable"], "unverified");
    assert_eq!(d["unverified"].as_array().unwrap().len(), UNVERIFIED.len());
}

#[test]
fn publication_gates_refuse_before_anything_destination_bearing_is_produced() {
    let (round, sig) = vector();
    // No beacon supplied, either opening.
    let mut fx = Fx::new();
    fx.publication = None;
    assert_eq!(blocked(fx.plan()), Err(Block::PublicationMissing));
    fx.opening = Opening::FromBeacon;
    assert_eq!(blocked(fx.plan()), Err(Block::PublicationMissing));
    // The wrong round (the real signature of another round is not T(arrive)).
    let mut fx = Fx::new();
    fx.publication = Some(Publication {
        round: round + 1,
        sig48: sig,
        pk96: pk96(),
    });
    assert_eq!(
        blocked(fx.plan()),
        Err(Block::BeaconRound {
            expected: round,
            got: round + 1
        })
    );
    // A key that does not hash to the Season's pin.
    let mut fx = Fx::new();
    let mut other = pk96();
    other[95] ^= 1;
    fx.publication = Some(Publication {
        round,
        sig48: sig,
        pk96: other,
    });
    assert_eq!(blocked(fx.plan()), Err(Block::BeaconKey));
    // A forged signature: byte-flipped (not a point, or not the round's).
    let mut fx = Fx::new();
    let mut forged = sig;
    forged[47] ^= 1;
    fx.publication = Some(Publication {
        round,
        sig48: forged,
        pk96: pk96(),
    });
    assert_eq!(blocked(fx.plan()), Err(Block::BeaconSignatureInvalid));
    // The Season pinned to another key: the published signature is of the
    // wrong key for this Season.
    let mut fx = Fx::new();
    assert!(wr_arr(&mut fx.season, SL::QUICKNET_PK_HASH, &[0x99; 32]));
    assert_eq!(blocked(fx.plan()), Err(Block::BeaconKey));
    // The gate runs before the transit record is read: a verified beacon
    // and an absent transit still block on the transit, but a missing
    // beacon blocks even when every other account is wrong.
    let mut fx = Fx::new();
    fx.transit = None;
    fx.publication = None;
    assert_eq!(blocked(fx.plan()), Err(Block::PublicationMissing));
    // THE anchor must be present: absent, or archive-only, is a typed
    // refusal even with a verified beacon (the handler would read the
    // archive; the keeper does not publish on it).
    let mut fx = Fx::new();
    fx.anchor = None;
    assert_eq!(blocked(fx.plan()), Err(Block::AnchorRequired("absent")));
    fx.archive = Some(archive_bytes());
    assert_eq!(
        blocked(fx.plan()),
        Err(Block::AnchorRequired("archive-only"))
    );
    // An anchor whose stored round is not the verified round: not the
    // canonical anchor of this bell (the stored round alone proves nothing).
    let mut fx = Fx::new();
    fx.anchor = Some(anchor_bytes(ARRIVE_BELL, REGION, a_ts(), round + 1));
    assert_eq!(blocked(fx.plan()), Err(Block::NotCanonical("anchor")));
    // `FromBeacon` under the verified publication against the literal
    // seal: the gate passes, the stock opener refuses the block (no real
    // tlock block exists here), nothing is derived from the root.
    let mut fx = Fx::new();
    fx.opening = Opening::FromBeacon;
    assert!(matches!(fx.plan(), Err(Block::SealOpen(_))));
}

#[test]
fn reveal_plan_rebinds_the_proof_to_the_record_as_it_is_now() {
    let fx = Fx::new();
    let root = fx.proof.seal_root;
    // A changed proof arrival fails public-round verification first.
    let mut bad = Fx::new();
    bad.proof.arrive_bell += 1;
    assert_eq!(
        blocked(bad.plan()),
        Err(Block::BeaconRound {
            expected: vector().0 + 200,
            got: vector().0
        })
    );
    // A changed current transit with the original valid publication must
    // still fail the explicit proof/current-record arrival binding.
    let mut bad = Fx::new();
    bad.transit = Some(
        transit_with(host(), ARRIVE_BELL + 1, root, depart_ts())
            .to_bytes()
            .to_vec(),
    );
    assert_eq!(
        blocked(bad.plan()),
        Err(Block::ProofMismatch("arrive_bell"))
    );
    // Each proof field against the record: the record is the truth.
    type ProofMutation = Box<dyn Fn(&mut DepartProof)>;
    let cases: [(&str, ProofMutation); 6] = [
        ("seal_root", Box::new(|p| p.seal_root = [0xAB; 32])),
        ("standing", Box::new(|p| p.standing = away())),
        ("depart_bell", Box::new(|p| p.depart_bell = DEPART_BELL + 1)),
        ("tip", Box::new(|p| p.tip = TIP + 1)),
        ("dep_mass", Box::new(|p| p.dep_mass_milli = TROOPS + 1)),
        ("march_stamina", Box::new(|p| p.march_stamina = 62)),
    ];
    for (field, change) in cases {
        let mut bad = Fx::new();
        change(&mut bad.proof);
        assert_eq!(
            blocked(bad.plan()),
            Err(Block::ProofMismatch(field)),
            "{field}"
        );
    }
    let mut bad = Fx::new();
    bad.proof.transit = Address::new_from_array([0xEE; 32]);
    assert_eq!(
        blocked(bad.plan()),
        Err(Block::ProofMismatch("holding or transit address"))
    );
    // Slot re-use: the same host departed again from the same slot (a
    // later march, another departure bell and root); the old proof is not
    // this record's. `proofs_for` is only a hint and does not know.
    let mut bad = Fx::new();
    let later = transit_full(
        host(),
        origin(),
        DEPART_BELL + 10,
        ARRIVE_BELL,
        [0xCD; 32],
        bell_start(genesis_ts(), DEPART_BELL + 10),
        TROOPS,
        61,
        TIP,
    );
    bad.transit = Some(later.to_bytes().to_vec());
    assert_eq!(blocked(bad.plan()), Err(Block::ProofMismatch("seal_root")));
    // The record moved on: freed → not in transit; absent → no march.
    let mut bad = Fx::new();
    let freed = transit_with(host(), ARRIVE_BELL, root, depart_ts())
        .step(
            MarchEvent::SettleDeparture { destroyed: false },
            Some((TROOPS, 61, 0)),
        )
        .unwrap()
        .step(MarchEvent::SettleTransit, None)
        .unwrap();
    bad.transit = Some(freed.to_bytes().to_vec());
    assert_eq!(
        blocked(bad.plan()),
        Err(Block::TransitState(MarchState::Free))
    );
    bad.transit = None;
    assert_eq!(blocked(bad.plan()), Err(Block::NoMarch));
    // A record of another holding's host at the slot.
    let mut bad = Fx::new();
    bad.transit = Some(
        transit_with(host_c(1), ARRIVE_BELL, root, depart_ts())
            .to_bytes()
            .to_vec(),
    );
    assert_eq!(blocked(bad.plan()), Err(Block::TransitOtherHost));
}

#[test]
fn reveal_plan_blocks_on_opening_and_season_problems() {
    let fx = Fx::new();
    // No opening: the planner never derives one.
    let r = match widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        None,
        fx.publication.as_ref(),
        &fx.reads(),
    ) {
        Step::Done(r) => r,
        Step::Need(a) => panic!("{a:?}"),
    };
    assert_eq!(blocked(r), Err(Block::NoOpening));
    // A supplied salt that does not reproduce the commitment.
    let mut bad = Fx::new();
    bad.opening = Opening::Supplied {
        plain: bad.plain,
        salt: [0x45; 32],
    };
    assert_eq!(blocked(bad.plan()), Err(Block::CommitMismatch));
    // A supplied plaintext of another march.
    let mut bad = Fx::new();
    bad.opening = Opening::Supplied {
        plain: wseal::pack(&plain_for(host_b(), ARRIVE_BELL)),
        salt: SALT,
    };
    assert_eq!(blocked(bad.plan()), Err(Block::CommitMismatch));
    // A plaintext committing to another host of the same holding, with the
    // record and proof consistent with it: the codec refuses it for this
    // record (`HostMismatch`), as the handler does.
    let mut bad = Fx::with_plain(plain_for(host_b(), ARRIVE_BELL), ARRIVE_BELL);
    bad.opening = Opening::Supplied {
        plain: bad.plain,
        salt: SALT,
    };
    assert!(matches!(bad.plan(), Err(Block::BadPlaintext(_))));
    // Season Ended with the arrival at or past the end bell.
    let mut bad = Fx::new();
    bad.season = season_bytes(SL::STATUS_ENDED, ARRIVE_BELL);
    assert_eq!(blocked(bad.plan()), Err(Block::SeasonEnded));
    bad.season = season_bytes(SL::STATUS_ENDED, ARRIVE_BELL + 1);
    assert!(bad.plan().is_ok(), "Ended before the arrival still reveals");
}

#[test]
fn reveal_plan_judges_the_window_by_the_observed_clock_and_the_log() {
    // No clock observed: the window cannot be judged.
    let mut fx = Fx::new();
    fx.clock = None;
    assert_eq!(blocked(fx.plan()), Err(Block::TimingNeedsClock));
    // The observed clock at or past `A + W`.
    let mut fx = Fx::new();
    fx.clock = Some(clock_at(a_ts() + REVEAL_WINDOW as i64));
    assert!(matches!(fx.plan(), Err(Block::WindowClosed(_))));
    // One second before the close still plans.
    let mut fx = Fx::new();
    fx.clock = Some(clock_at(a_ts() + REVEAL_WINDOW as i64 - 1));
    assert!(fx.plan().is_ok());
    // The beacon log at the seed round, or past it.
    let mut fx = Fx::new();
    fx.log = Some(log_bytes(REGION, seed_round()));
    assert!(matches!(fx.plan(), Err(Block::WindowClosed(_))));
    fx.log = Some(log_bytes(REGION, seed_round() - 1));
    assert!(fx.plan().is_ok());
    // The log absent, or of another region.
    let mut fx = Fx::new();
    fx.log = None;
    assert_eq!(blocked(fx.plan()), Err(Block::Absent("beaconlog")));
    fx.log = Some(log_bytes(REGION + 1, 1));
    assert_eq!(blocked(fx.plan()), Err(Block::NotCanonical("beaconlog")));
    // An anchor of another bell or region at the position.
    let mut fx = Fx::new();
    fx.anchor = Some(anchor_bytes(ARRIVE_BELL + 1, REGION, a_ts(), vector().0));
    assert_eq!(blocked(fx.plan()), Err(Block::NotCanonical("anchor")));
}

#[test]
fn reveal_plan_replays_latch_path_shield_quota_and_arrival_day() {
    // The latch: inputs present, or the destination resolved past the arrival.
    let mut fx = Fx::new();
    fx.inputs = Some(vec![0u8; 16]);
    assert_eq!(
        blocked(fx.plan()),
        Err(Block::LatchClosed("clash inputs present"))
    );
    let mut fx = Fx::new();
    fx.dest = province_bytes(home(), ARRIVE_BELL + 1);
    assert!(matches!(fx.plan(), Err(Block::LatchClosed(_))));
    // The destination tile impassable.
    let mut fx = Fx::new();
    let (_, dest_tile) = one_step();
    assert!(wr_u64(
        &mut fx.dest,
        PV::PASSABLE_MASK,
        ((1u64 << 61) - 1) & !(1u64 << dest_tile)
    ));
    assert_eq!(blocked(fx.plan()), Err(Block::Path("impassable tile")));
    // The arrival bell earlier than the walk allows (the departure stamped
    // at bell 19 for an arrival at bell 20).
    let mut fx = Fx::new();
    fx.transit = Some(
        transit_with(
            host(),
            ARRIVE_BELL,
            fx.proof.seal_root,
            bell_start(genesis_ts(), 19),
        )
        .to_bytes()
        .to_vec(),
    );
    assert_eq!(blocked(fx.plan()), Err(Block::ArrivalBell));
    // A shielded site of another faction under the destination tile.
    let shielded = |site_shield: u32, holding_shield: i64, dormant: bool| {
        let mut fx = Fx::new();
        fx.dest[PV::SITE_COUNT] = 1;
        fx.dest[PV::SITES] = dest_tile;
        let o = PV::site(0);
        fx.dest[o + SM::STATE] = SM::STATE_HOLDING;
        fx.dest[o + SM::FACTION] = 1;
        assert!(wr_u32(&mut fx.dest, o + SM::SHIELD_UNTIL_BELL, site_shield));
        assert!(wr_arr(
            &mut fx.holding,
            H::SHIELD_UNTIL,
            &holding_shield.to_le_bytes()
        ));
        if dormant {
            fx.holding[H::FLAGS] |= H::FLAG_DORMANT_CACHE;
        }
        blocked(fx.plan())
    };
    assert_eq!(shielded(ARRIVE_BELL + 1, 0, false), Err(Block::Shielded));
    assert_eq!(
        shielded(0, bell_start(genesis_ts(), ARRIVE_BELL) + 1, false),
        Err(Block::Shielded)
    );
    assert_eq!(
        shielded(0, bell_start(genesis_ts(), ARRIVE_BELL) + 1, true),
        Ok(())
    );
    assert_eq!(shielded(ARRIVE_BELL, 0, false), Ok(()));
    // The quota over the four slots.
    let mut fx = Fx::new();
    fx.slots[0] = Some(slot_bytes(0, host(), citizen(), TROOPS));
    assert_eq!(blocked(fx.plan()), Err(Block::AlreadyRevealed));
    let mut fx = Fx::new();
    fx.slots[0] = Some(slot_bytes(0, host_c(1), other_citizen(), TROOPS + 1));
    let c = fx.plan().unwrap();
    assert_eq!(c.facts.target_i, 1);
    assert_eq!(c.instruction.accounts, fx.expected_accounts(1, true));
    assert_eq!(c.instruction.data, fx.expected_data(1));
    // Full with larger arrivals: refused. One smaller: displaced.
    let mut fx = Fx::new();
    for (i, s) in fx.slots.iter_mut().enumerate() {
        *s = Some(slot_bytes(
            i as u8,
            host_c(10 + i as u32),
            other_citizen(),
            TROOPS + 1,
        ));
    }
    assert_eq!(blocked(fx.plan()), Err(Block::QuotaRefused("full")));
    fx.slots[2] = Some(slot_bytes(2, host_c(12), other_citizen(), TROOPS - 1));
    let c = fx.plan().unwrap();
    assert_eq!((c.facts.target_i, c.facts.displaced), (2, Some(host_c(12))));
    // The same Citizen's larger host already in: refused; smaller: displaced.
    let mut fx = Fx::new();
    fx.slots[3] = Some(slot_bytes(3, host_b(), citizen(), TROOPS + 1));
    assert_eq!(
        blocked(fx.plan()),
        Err(Block::QuotaRefused("citizen has a larger arrival"))
    );
    fx.slots[3] = Some(slot_bytes(3, host_b(), citizen(), TROOPS - 1));
    let c = fx.plan().unwrap();
    assert_eq!((c.facts.target_i, c.facts.displaced), (3, Some(host_b())));
    // A slot of another bell at the position: BadAccount.
    let mut fx = Fx::new();
    let mut s = slot_bytes(1, host_c(1), other_citizen(), TROOPS);
    assert!(wr_u32(&mut s, wa::wide_arrival_slot::BELL, ARRIVE_BELL + 1));
    fx.slots[1] = Some(s);
    assert_eq!(blocked(fx.plan()), Err(Block::NotCanonical("slot")));
    // The ArrivalDay present: writable only while the bell's bit is clear.
    let mut fx = Fx::new();
    fx.day = Some(day_bytes(false));
    let c = fx.plan().unwrap();
    assert!(c.facts.day_present && !c.facts.day_bit_set);
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, true));
    fx.day = Some(day_bytes(true));
    let c = fx.plan().unwrap();
    assert!(c.facts.day_present && c.facts.day_bit_set);
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, false));
}

// ------------------------------------------------------------ the port

struct FakePort {
    accounts: BTreeMap<Address, Option<Account>>,
    clock: ClockSysvar,
    min_slots: Mutex<Vec<u64>>,
    forbidden: AtomicUsize,
}

impl ChainPort for FakePort {
    fn clock(&self) -> impl Future<Output = PortResult<ClockSysvar>> + Send {
        let c = self.clock;
        async move { Ok(c) }
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
fn reveal_driver_reads_in_three_rounds_at_the_bound_and_never_simulates_or_sends() {
    let fx = Fx::new();
    let pb = publication();
    let port = FakePort {
        accounts: fx.reads().accounts,
        clock: clock_at(a_ts() + 10),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let c = block_on(widereveal::reveal_via(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        42,
    ))
    .unwrap();
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, true));
    assert_eq!(c.min_slot, 42);
    assert_eq!(c.observed_clock.map(|c| c.slot), Some(900));
    assert!(!c.coherent);
    assert_eq!(*port.min_slots.lock().unwrap(), vec![42, 42, 42]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // Without the publication the driver stops after the first round:
    // nothing destination-bearing is read or produced.
    let port = FakePort {
        accounts: fx.reads().accounts,
        clock: clock_at(a_ts() + 10),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let r = block_on(widereveal::reveal_via(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        None,
        42,
    ));
    assert_eq!(blocked(r), Err(Block::PublicationMissing));
    assert_eq!(*port.min_slots.lock().unwrap(), vec![42]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // A port whose clock is past the close: blocked by the observed clock.
    let port = FakePort {
        accounts: fx.reads().accounts,
        clock: clock_at(a_ts() + REVEAL_WINDOW as i64 + 1),
        min_slots: Mutex::new(vec![]),
        forbidden: AtomicUsize::new(0),
    };
    let r = block_on(widereveal::reveal_via(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        42,
    ));
    assert!(matches!(r, Err(Block::WindowClosed(_))));
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------ the review

#[test]
fn review_denies_every_wide_candidate_with_concrete_reasons_and_enqueues_nothing() {
    let fx = Fx::new();
    let c = fx.plan().unwrap();
    let subject = Subject::of_reveal(&c);
    assert_eq!(
        subject.key,
        format!(
            "wide-reveal:{}:{}:{}:{}",
            hex::encode(world().as_bytes()),
            hex::encode(host().to_bytes()),
            SLOT,
            ARRIVE_BELL
        )
    );
    assert_eq!(
        (subject.kind, subject.tag),
        (widereview::KIND_REVEAL, wix::TAG_REVEAL)
    );
    assert_eq!(subject.class, fclient::abi::Class::W);
    assert_eq!(subject.accounts, wix::REVEAL_FIXED);
    // An engine in its most permissive public state still denies: the six
    // hard denials of this slice, including the unknown history and the
    // unverified publication evidence.
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    let r = widereview::review(subject.clone(), &open);
    assert_eq!(r.denials, HARD_DENIALS.to_vec());
    assert!(r.denials.contains(&Deny::HistoryUnknown));
    assert!(r.denials.contains(&Deny::ExecutionEvidenceUnverified));
    assert!(r.denials.contains(&Deny::SliceDoesNotEnqueue));
    assert!(!r.admitted);
    assert_eq!(r.describe()["enqueued"], false);
    // A caller that flips the candidate's own flags changes nothing: the
    // review does not read them.
    let mut flipped = c.clone();
    flipped.coherent = true;
    flipped.automatic_send = true;
    flipped.signed = true;
    flipped.facts.unverified.clear();
    let r2 = widereview::review(Subject::of_reveal(&flipped), &open);
    assert_eq!(r2.denials, r.denials);
    assert!(!r2.admitted);
    // Engine facts add denials when they apply.
    let paused = EngineView {
        feed_writes_allowed: false,
        kind_allowed: false,
        already_pending: true,
        care_unresolved: true,
    };
    let r3 = widereview::review(subject.clone(), &paused);
    assert_eq!(r3.denials.len(), HARD_DENIALS.len() + 4);
    assert!(r3.denials.contains(&Deny::FeedWritesPaused));
    assert!(r3.denials.contains(&Deny::AlreadyPending));
    // Against a real engine (no payer pool, no key), read only. The engine
    // itself would accept the wide kind while the feed is ready — the gate
    // is this review, not the engine — and nothing is pending before or
    // after.
    let mut engine = Engine::new(Budgets::default(), EngineParams::default());
    assert!(
        engine.allows_write_kind(widereview::KIND_REVEAL),
        "the engine does not refuse wide kinds by itself"
    );
    assert_eq!(engine.pending_len(), 0);
    let r4 = widereview::review_with_engine(&engine, subject.clone());
    assert_eq!(
        r4.denials,
        HARD_DENIALS.to_vec(),
        "a ready engine adds no denial of its own"
    );
    assert!(!r4.admitted);
    engine.set_feed_ready(false);
    let r5 = widereview::review_with_engine(&engine, subject);
    assert!(r5.denials.contains(&Deny::FeedWritesPaused));
    assert!(
        r5.denials.contains(&Deny::KindNotAllowed),
        "wide kinds are not in the paused allowlist"
    );
    assert_eq!(engine.pending_len(), 0);
    assert!(!engine.is_pending(&r5.subject.key));
    // A settle candidate's subject: the key by full identity, class D.
    let settle = wideduty::Candidate {
        duty: wideduty::Duty::SettleDeparture(wideduty::SettleFacts {
            host: host(),
            transit_slot: SLOT,
            origin: home(),
            depart_bell: DEPART_BELL,
            resolved_next: DEPART_BELL + 1,
            entry_index: 4,
            kernel_troops_milli: TROOPS,
            kernel_stamina: 61,
            predicted_destroyed: false,
            troops_after_milli: TROOPS,
            stamina_after: 61,
            ready_bell_off: 0,
            origin_is_home: true,
        }),
        instruction: Instruction {
            program_id: program(),
            accounts: vec![],
            data: vec![],
        },
        payer: payer(),
        min_slot: 0,
        observed_clock: None,
        coherent: false,
        status_promoted_by_clock: false,
        signed: false,
        automatic_send: false,
    };
    let s = Subject::of_duty(&settle);
    assert_eq!(
        s.key,
        format!(
            "wide-settle-departure:{}:{}:{}",
            hex::encode(world().as_bytes()),
            hex::encode(host().to_bytes()),
            SLOT
        )
    );
    assert_eq!(
        (s.kind, s.tag, s.class),
        (
            widereview::KIND_SETTLE_DEPARTURE,
            wix::TAG_SETTLE_TICKET,
            fclient::abi::Class::D
        )
    );
}
