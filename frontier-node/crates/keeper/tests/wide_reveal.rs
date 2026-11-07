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
use fclient::decode::Season;
use fclient::ports::{
    Account, Beacon, ChainInfo, ChainPort, ClockSysvar, Cursor, DrandPort, PortError, PortResult,
    Signature, SimResult, Status, TxRecord,
};
use fclient::rpc::account_json;
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
use keeper_core::widefees::{self, Funding, Known};
use keeper_core::wideindex::{Limits, Scope as IndexScope, WideDiscovery};
use keeper_core::wideproof::{DepartProof, Provenance};
use keeper_core::widereveal::{
    self, Crypto, Opening, Publication, RevealCandidate, UNVERIFIED, UNVERIFIED_COHERENCE,
    UNVERIFIED_CURRENCY,
};
use keeper_core::widereview::{self, Deny, EngineView, Subject, HARD_DENIALS};
use keeper_core::widesnapshot::{
    parse_snapshot_response, rent_sysvar, sysvar_owner, RentSysvar, Snapshot, SnapshotError,
    SnapshotPort, MAX_SNAPSHOT_KEYS,
};
use keeper_core::widetick::{
    is_transient, BeaconCache, DrandPublications, RevealInputs, WideReview, ORIGIN_SUPPLIED,
    REFRESH_SLOTS,
};
use permutation_rules::frontier::beacon::{bell_start, first_round_from};
use permutation_rules::frontier::seal::encode_path;
use permutation_rules::frontier::seal::salt_of;
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::AccountMeta;

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
/// The slot the fixture arrival fills (`target_i = 0`).
fn wide_slot_addr0() -> Address {
    slot_addr(0)
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

/// The commitment and root of `plain` under `salt` and `seal`.
fn roots(
    plain: &[u8; WIDE_PLAIN_LEN],
    salt: &[u8; 32],
    seal: &[u8; WIDE_SEAL_LEN],
) -> ([u8; 32], [u8; 32]) {
    let c = wseal::commit(plain, salt);
    (c, wseal::seal_root(&c, &wseal::ct_hash(seal)))
}

/// The recorded **public** seal vector `valid_spv2_32551361`
/// (`permutation-rules/vectors/seal-vectors-v1.json`): its IBE block
/// (sealed to quicknet round 32551361, the shipped fixture round) and the
/// key `k` the stock opener recovers from it. Public, recorded material;
/// nothing is generated here.
fn recorded_vector() -> ([u8; wseal::IBE_LEN], [u8; 16]) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-rules/vectors/seal-vectors-v1.json");
    let j: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json");
    let c = j["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["name"] == "valid_spv2_32551361")
        .expect("the recorded vector");
    assert_eq!(
        c["round"].as_u64(),
        Some(vector().0),
        "the vector's round is the fixture round"
    );
    let legacy = hex::decode(c["seal"].as_str().unwrap()).unwrap();
    let k: [u8; 16] = hex::decode(c["k"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let open_sig: [u8; 48] = hex::decode(c["open_sig"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        open_sig,
        vector().1,
        "the vector's round signature is the shipped quicknet one"
    );
    let mut ibe = [0u8; wseal::IBE_LEN];
    ibe.copy_from_slice(&legacy[..wseal::IBE_LEN]);
    (ibe, k)
}

/// A **fixture** proof: literal, labelled, not extracted from a record.
fn proof_for(
    plain: &[u8; WIDE_PLAIN_LEN],
    arrive: u32,
    salt: &[u8; 32],
    seal: &[u8; WIDE_SEAL_LEN],
) -> DepartProof {
    let (commit, root) = roots(plain, salt, seal);
    DepartProof {
        host: host(),
        standing: home(),
        transit_slot: SLOT,
        depart_bell: DEPART_BELL,
        arrive_bell: arrive,
        tip: TIP,
        commit,
        seal: *seal,
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
    /// A fixture whose transit record and proof commit to `plain` under
    /// the literal salt and the literal (unopenable) seal.
    fn with_plain(pt: WidePlain, arrive: u32) -> Fx {
        Fx::with_material(pt, arrive, SALT, seal())
    }
    /// A fixture whose transit record and proof commit to `plain` under
    /// `salt` and `seal`.
    fn with_material(pt: WidePlain, arrive: u32, salt: [u8; 32], seal: [u8; WIDE_SEAL_LEN]) -> Fx {
        let plain = wseal::pack(&pt);
        let proof = proof_for(&plain, arrive, &salt, &seal);
        let t = transit_with(host(), arrive, proof.seal_root, depart_ts());
        let (round, _) = vector();
        Fx {
            plain,
            proof,
            opening: Opening::Supplied { plain, salt },
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
        self.expected_data_with(target_i, SALT)
    }
    fn expected_data_with(&self, target_i: u8, salt: [u8; 32]) -> Vec<u8> {
        Reveal {
            transit_slot: SLOT,
            target_i,
            plain: self.plain,
            salt,
            ct_hash: wseal::ct_hash(&self.proof.seal),
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
    assert_eq!(f.unverified.len(), UNVERIFIED.len() + 1);
    assert!(f.unverified.starts_with(&UNVERIFIED));
    assert!(
        f.unverified.contains(&UNVERIFIED_COHERENCE),
        "ordinary reads: not one response"
    );
    assert!(!f.unverified.contains(&UNVERIFIED_CURRENCY));
    assert!(f.budget_prefix_policy.contains("keeper policy"));
    assert!(!c.coherent() && !c.signed && !c.automatic_send && !c.status_promoted_by_clock);
    assert!(c.snapshot().is_none());
    let d = c.describe();
    assert_eq!(d["crypto"], "CommitmentOnly");
    assert_eq!(d["automatic_send"], false);
    assert_eq!(d["coherent"], false);
    assert_eq!(d["executable"], "unverified");
    assert_eq!(
        d["unverified"].as_array().unwrap().len(),
        UNVERIFIED.len() + 1
    );
}

/// The recorded public vector under `Opening::FromBeacon`: the IBE block
/// of `valid_spv2_32551361` opens with the stock opener under the shipped
/// quicknet signature of round 32551361 (the fixture Season's `T(20)`),
/// the wide body sealed under the recorded key reproduces the proof's
/// commitment, and the candidate is labelled `Crypto::IbeOpened`. A
/// fixture over public material, not a live chain; every corruption
/// refuses.
#[test]
fn from_beacon_opens_the_recorded_public_vector_and_corruptions_refuse() {
    let (ibe, k) = recorded_vector();
    let pt = plain_for(host(), ARRIVE_BELL);
    let plain = wseal::pack(&pt);
    let seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &plain));
    let salt = salt_of(&k);
    let mut fx = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    fx.opening = Opening::FromBeacon;
    let c = fx.plan().unwrap();
    assert_eq!(c.facts.crypto, Crypto::IbeOpened);
    assert_eq!(c.instruction.data, fx.expected_data_with(0, salt));
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, true));
    assert_eq!(
        (
            c.facts.publication.round,
            c.facts.publication.signature_verified
        ),
        (vector().0, true)
    );
    assert!(!c.coherent() && !c.signed && !c.automatic_send);
    // The same material under a supplied opening with the derived salt.
    fx.opening = Opening::Supplied { plain, salt };
    let c2 = fx.plan().unwrap();
    assert_eq!(c2.facts.crypto, Crypto::CommitmentOnly);
    assert_eq!(c2.instruction.data, c.instruction.data);
    // Corruptions. A flipped byte in the IBE block's `V`: the FO check
    // fails, nothing is derived from the root.
    let mut bad = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    bad.opening = Opening::FromBeacon;
    bad.proof.seal[96] ^= 1;
    bad.proof.seal_root = roots(&plain, &salt, &bad.proof.seal).1;
    bad.transit = Some(
        transit_with(host(), ARRIVE_BELL, bad.proof.seal_root, depart_ts())
            .to_bytes()
            .to_vec(),
    );
    assert!(matches!(bad.plan(), Err(Block::SealOpen(_))));
    // A flipped body byte: the block opens, the body does not reproduce
    // the commitment.
    let mut bad = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    bad.opening = Opening::FromBeacon;
    bad.proof.seal[wseal::IBE_LEN] ^= 1;
    bad.proof.seal_root = roots(&plain, &salt, &bad.proof.seal).1;
    bad.transit = Some(
        transit_with(host(), ARRIVE_BELL, bad.proof.seal_root, depart_ts())
            .to_bytes()
            .to_vec(),
    );
    assert_eq!(blocked(bad.plan()), Err(Block::CommitMismatch));
    // The opener's key is the publication's signature: another round's
    // real signature is refused by the gate before any opening.
    let mut bad = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    bad.opening = Opening::FromBeacon;
    let (r2, sig2) = {
        let f = FixtureDrand::load(&beacon::fixture_dir(), beacon::quicknet_info()).unwrap();
        let (r, b) = f.rounds.iter().nth(1).expect("a second shipped round");
        (*r, b.sig48)
    };
    bad.publication = Some(Publication {
        round: r2,
        sig48: sig2,
        pk96: pk96(),
    });
    assert_eq!(
        blocked(bad.plan()),
        Err(Block::BeaconRound {
            expected: vector().0,
            got: r2
        })
    );
    // The record's root of another seal (a later march reused the slot):
    // the proof is not this record's, whatever the opening.
    let mut bad = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    bad.opening = Opening::FromBeacon;
    bad.transit = Some(
        transit_with(host(), ARRIVE_BELL, [0xCD; 32], depart_ts())
            .to_bytes()
            .to_vec(),
    );
    assert_eq!(blocked(bad.plan()), Err(Block::ProofMismatch("seal_root")));
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
    /// The Rent sysvar the fake serves in a snapshot (`None`: absent).
    rent: Option<RentSysvar>,
    /// The context slot the fake's snapshot responses carry.
    context_slot: u64,
    snapshot_calls: AtomicUsize,
    /// The keys of every snapshot request made through `SharedPort`.
    snapshot_keys: Mutex<Vec<Vec<Address>>>,
}

impl FakePort {
    fn new(accounts: BTreeMap<Address, Option<Account>>, clock: ClockSysvar) -> FakePort {
        FakePort {
            accounts,
            clock,
            min_slots: Mutex::new(vec![]),
            forbidden: AtomicUsize::new(0),
            rent: Some(RENT),
            // A coherent response: the Clock's slot is the context slot.
            context_slot: clock.slot,
            snapshot_calls: AtomicUsize::new(0),
            snapshot_keys: Mutex::new(vec![]),
        }
    }
    /// The `getMultipleAccounts` JSON the fake would return for one
    /// snapshot request: the accounts, then the Clock, then the Rent.
    fn snapshot_json(&self, keys: &[Address], with_rent: bool) -> Value {
        let mut value: Vec<Value> = keys
            .iter()
            .map(|k| match self.accounts.get(k).cloned().flatten() {
                Some(a) => account_json(&a),
                None => Value::Null,
            })
            .collect();
        value.push(account_json(&sysvar_account(self.clock.encode().to_vec())));
        if with_rent {
            value.push(match self.rent {
                Some(r) => account_json(&sysvar_account(rent_bytes(&r))),
                None => Value::Null,
            });
        }
        json!({"context": {"slot": self.context_slot, "apiVersion": "fixture"}, "value": value})
    }
}

/// The default Rent parameters (3,480 lamports per byte-year, two years).
const RENT: RentSysvar = RentSysvar {
    lamports_per_byte_year: 3_480,
    exemption_threshold: 2.0,
    burn_percent: 50,
};
fn rent_bytes(r: &RentSysvar) -> Vec<u8> {
    let mut d = Vec::with_capacity(17);
    d.extend_from_slice(&r.lamports_per_byte_year.to_le_bytes());
    d.extend_from_slice(&r.exemption_threshold.to_le_bytes());
    d.push(r.burn_percent);
    d
}
fn sysvar_account(data: Vec<u8>) -> Account {
    Account {
        lamports: 1,
        data,
        owner: sysvar_owner(),
        executable: false,
    }
}

impl SnapshotPort for FakePort {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        self.snapshot_calls.fetch_add(1, Ordering::SeqCst);
        let r = parse_snapshot_response(
            &self.snapshot_json(keys, with_rent),
            keys,
            with_rent,
            min_slot,
        );
        async move { r }
    }
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
    let port = FakePort::new(fx.reads().accounts, clock_at(a_ts() + 10));
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
    assert!(!c.coherent());
    assert_eq!(*port.min_slots.lock().unwrap(), vec![42, 42, 42]);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    // Without the publication the driver stops after the first round:
    // nothing destination-bearing is read or produced.
    let port = FakePort::new(fx.reads().accounts, clock_at(a_ts() + 10));
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
    let port = FakePort::new(
        fx.reads().accounts,
        clock_at(a_ts() + REVEAL_WINDOW as i64 + 1),
    );
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

// ------------------------------------------------------------ the snapshot

#[test]
fn snapshot_parsing_refuses_partial_malformed_oversized_stale_and_bad_sysvar_responses() {
    let fx = Fx::new();
    let clock = clock_at(a_ts() + 10);
    let port = FakePort::new(fx.reads().accounts, clock);
    let keys = [season_pda().0, holding_addr(), transit_addr(), payer()];
    let parse = |v: &Value, keys: &[Address], rent: bool, min: u64| {
        parse_snapshot_response(v, keys, rent, min)
    };
    // A complete response: every key, the Clock, the Rent, the context at
    // or past the requested minimum.
    let ok = parse(&port.snapshot_json(&keys, true), &keys, true, 900).unwrap();
    assert_eq!(ok.meta().context_slot(), 900);
    assert_eq!(ok.meta().min_slot(), 900);
    assert_eq!(ok.meta().commitment(), "confirmed");
    assert_eq!((ok.meta().keys(), ok.meta().rent_included()), (4, true));
    assert_eq!(ok.clock(), clock);
    assert_eq!(ok.rent(), Some(RENT));
    assert_eq!(ok.accounts().len(), 4);
    assert_eq!(
        ok.accounts()[&payer()],
        None,
        "the payer is absent in this fixture"
    );
    let reads = ok.reads();
    assert_eq!(reads.min_slot, 900);
    assert_eq!(reads.clock, Some(clock));
    assert!(
        reads.coherent_snapshot().is_some(),
        "untouched reads re-verify"
    );
    // A lower requested minimum is fine and part of the digest.
    let ok7 = parse(&port.snapshot_json(&keys, true), &keys, true, 7).unwrap();
    assert_eq!(ok7.meta().min_slot(), 7);
    assert_ne!(
        ok7.meta().digest(),
        ok.meta().digest(),
        "the requested slot is bound"
    );
    // Stale: the context below the requested minimum.
    assert_eq!(
        parse(&port.snapshot_json(&keys, true), &keys, true, 901),
        Err(SnapshotError::Stale {
            context_slot: 900,
            min_slot: 901
        })
    );
    // Without the Rent when not asked.
    let no_rent = parse(&port.snapshot_json(&keys, false), &keys, false, 0).unwrap();
    assert_eq!(no_rent.rent(), None);
    assert!(!no_rent.meta().rent_included());
    // Rent asked for and absent, short, foreign-owned or executable.
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5] = Value::Null;
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("absent"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5] = account_json(&sysvar_account(vec![0u8; 3]));
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("length"))
    );
    let mut v = port.snapshot_json(&keys, true);
    let mut foreign = sysvar_account(rent_bytes(&RENT));
    foreign.owner = program();
    v["value"][5] = account_json(&foreign);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("not owned by the sysvar owner"))
    );
    let mut v = port.snapshot_json(&keys, true);
    let mut exec = sysvar_account(rent_bytes(&RENT));
    exec.executable = true;
    v["value"][5] = account_json(&exec);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("executable"))
    );
    // The sysvar JSON must say `"executable": false` itself: a missing or
    // non-boolean field is not taken as false (the generic account parser
    // would default it).
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5].as_object_mut().unwrap().remove("executable");
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5]["executable"] = json!("false");
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5]["executable"] = json!(0);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][5]["executable"] = json!(true);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadRent("executable"))
    );
    // The Clock absent, short, long, foreign-owned, executable (said,
    // unsaid or said as a string), or of another slot than the context.
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4] = Value::Null;
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("absent"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4]["executable"] = json!(true);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4].as_object_mut().unwrap().remove("executable");
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4]["executable"] = json!("false");
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("executable"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4]["executable"] = Value::Null;
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("executable"))
    );
    // An ordinary account's missing flag is still the generic parser's
    // business: only the sysvars are strict.
    let mut v = port.snapshot_json(&keys, true);
    v["value"][1].as_object_mut().unwrap().remove("executable");
    assert!(
        parse(&v, &keys, true, 0).is_ok(),
        "a plain account without the flag parses as before"
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4] = account_json(&sysvar_account(vec![0u8; 39]));
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("length"))
    );
    let mut v = port.snapshot_json(&keys, true);
    v["value"][4] = account_json(&sysvar_account(vec![0u8; 41]));
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("length"))
    );
    let mut v = port.snapshot_json(&keys, true);
    let mut foreign = sysvar_account(clock.encode().to_vec());
    foreign.owner = program();
    v["value"][4] = account_json(&foreign);
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock("not owned by the sysvar owner"))
    );
    let mut v = port.snapshot_json(&keys, true);
    let mut other = clock;
    other.slot = 899;
    v["value"][4] = account_json(&sysvar_account(other.encode().to_vec()));
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::BadClock(
            "slot differs from the context slot"
        ))
    );
    // A chunked or partial response: not the requested count.
    let mut v = port.snapshot_json(&keys, true);
    v["value"].as_array_mut().unwrap().pop();
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::Partial { want: 6, got: 5 })
    );
    // No context slot.
    let mut v = port.snapshot_json(&keys, true);
    v["context"] = json!({});
    assert_eq!(
        parse(&v, &keys, true, 0),
        Err(SnapshotError::Malformed("no context.slot"))
    );
    // A duplicate key: the response cannot be bound to the request.
    let dup = [payer(), holding_addr(), payer()];
    assert_eq!(
        parse(&port.snapshot_json(&dup, false), &dup, false, 0),
        Err(SnapshotError::DuplicateKey)
    );
    // Too many keys for one response: refused before any request.
    let many: Vec<Address> = (0..=MAX_SNAPSHOT_KEYS as u8)
        .map(|i| Address::new_from_array([i; 32]))
        .collect();
    assert_eq!(
        parse(&json!({}), &many, false, 0),
        Err(SnapshotError::TooManyKeys {
            n: MAX_SNAPSHOT_KEYS + 1,
            max: MAX_SNAPSHOT_KEYS
        })
    );
    // The default capability: a port that cannot report a context.
    struct Nothing;
    impl SnapshotPort for Nothing {}
    assert_eq!(
        block_on(Nothing.snapshot(&keys, true, 0)),
        Err(SnapshotError::Unsupported)
    );
    assert_eq!(
        rent_sysvar().to_string(),
        "SysvarRent111111111111111111111111111111111"
    );
    assert_eq!(
        sysvar_owner().to_string(),
        "Sysvar1111111111111111111111111111111111111"
    );
    // The runtime's full minimum balance at the default parameters.
    assert_eq!(
        RENT.minimum_balance(wa::wide_arrival_slot::SIZE),
        Some((128 + 288) * 3_480 * 2)
    );
    assert_eq!(
        RENT.minimum_balance(wa::wide_arrival_day::SIZE),
        Some((128 + 144) * 3_480 * 2)
    );
    assert_eq!(
        RENT.minimum_balance(usize::MAX),
        None,
        "overflow is refused"
    );
    assert_eq!(
        RentSysvar {
            lamports_per_byte_year: 1,
            exemption_threshold: 144_115_188_075_855_872.0,
            burn_percent: 0
        }
        .minimum_balance(0),
        None,
        "2^64 float boundary is not a u64"
    );
    assert_eq!(RentSysvar::decode(&rent_bytes(&RENT)), Some(RENT));
    assert_eq!(RentSysvar::decode(&rent_bytes(&RENT)[..16]), None);
}

/// Provenance is sealed: a meta is worth exactly the bytes it was built
/// over. Any edit to reads that carry one, or a meta carried onto other
/// reads, re-verifies as nothing, and a plan over such reads is not
/// coherent.
#[test]
fn snapshot_provenance_cannot_be_moved_onto_other_bytes() {
    let fx = Fx::new();
    let clock = clock_at(a_ts() + 10);
    let port = FakePort::new(fx.reads().accounts, clock);
    // Every planned key **and** the payer: the payer's balance is what the
    // second response below differs in.
    let mut keys: Vec<Address> = fx.reads().accounts.keys().copied().collect();
    keys.push(payer());
    let snap = parse_snapshot_response(&port.snapshot_json(&keys, true), &keys, true, 900).unwrap();
    let pristine = snap.reads();
    assert!(pristine.coherent_snapshot().is_some());
    assert!(
        pristine.accounts.contains_key(&payer()),
        "the payer was requested"
    );
    // An account's lamports edited.
    let mut r = snap.reads();
    if let Some(Some(a)) = r.accounts.get_mut(&holding_addr()) {
        a.lamports += 1;
    }
    assert!(r.coherent_snapshot().is_none(), "edited lamports");
    // An account's data edited.
    let mut r = snap.reads();
    if let Some(Some(a)) = r.accounts.get_mut(&holding_addr()) {
        a.data[0] ^= 1;
    }
    assert!(r.coherent_snapshot().is_none(), "edited data");
    // An account added, or removed.
    let mut r = snap.reads();
    r.accounts.insert(Address::new_from_array([0x99; 32]), None);
    assert!(r.coherent_snapshot().is_none(), "added key");
    let mut r = snap.reads();
    r.accounts.remove(&transit_addr());
    assert!(r.coherent_snapshot().is_none(), "removed key");
    // An absent account made present.
    let mut r = snap.reads();
    r.accounts.insert(
        inputs_addr(),
        Some(Account {
            lamports: 1,
            data: vec![0; 16],
            owner: program(),
            executable: false,
        }),
    );
    assert!(r.coherent_snapshot().is_none(), "presence flipped");
    // The requested slot, the clock or the rent changed.
    let mut r = snap.reads();
    r.min_slot = 7;
    assert!(r.coherent_snapshot().is_none(), "min_slot");
    let mut r = snap.reads();
    r.clock = Some(clock_at(a_ts() + 11));
    assert!(r.coherent_snapshot().is_none(), "clock");
    let mut r = snap.reads();
    r.clock = None;
    assert!(r.coherent_snapshot().is_none(), "no clock");
    let mut r = snap.reads();
    r.rent = None;
    assert!(r.coherent_snapshot().is_none(), "rent dropped");
    let mut r = snap.reads();
    r.rent = Some(RentSysvar {
        lamports_per_byte_year: 1,
        ..RENT
    });
    assert!(r.coherent_snapshot().is_none(), "rent swapped");
    // The meta cloned onto reads of another response (same keys, another
    // payer balance): nothing.
    let mut other_accounts = fx.reads().accounts;
    other_accounts.insert(
        payer(),
        Some(Account {
            lamports: 5,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let other_port = FakePort::new(other_accounts, clock);
    let other =
        parse_snapshot_response(&other_port.snapshot_json(&keys, true), &keys, true, 900).unwrap();
    assert_ne!(
        other.reads().accounts.get(&payer()),
        snap.reads().accounts.get(&payer()),
        "the two responses differ in the payer's bytes"
    );
    assert_ne!(
        other.meta().digest(),
        snap.meta().digest(),
        "the two snapshots differ"
    );
    assert!(
        other.reads().coherent_snapshot().is_some(),
        "the other response verifies on its own"
    );
    let mut forged = other.reads();
    forged.snapshot = Some(snap.meta().clone());
    assert!(
        forged.coherent_snapshot().is_none(),
        "a meta moved onto other bytes"
    );
    let mut forged = snap.reads();
    forged.snapshot = Some(other.meta().clone());
    assert!(
        forged.coherent_snapshot().is_none(),
        "the other meta moved onto these bytes"
    );
    // A plan over edited snapshot reads is not coherent and says so; the
    // plan over the pristine reads is.
    let pb = publication();
    let mut edited = snap.reads();
    if let Some(Some(a)) = edited.accounts.get_mut(&holding_addr()) {
        a.lamports += 1;
    }
    let plan = |reads: &Reads| match widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        reads,
    ) {
        Step::Done(r) => r,
        Step::Need(a) => panic!("{a:?}"),
    };
    let c_edited = plan(&edited).unwrap();
    assert!(!c_edited.coherent());
    assert!(c_edited.snapshot().is_none());
    assert!(c_edited.facts.unverified.contains(&UNVERIFIED_COHERENCE));
    let c_ok = plan(&pristine).unwrap();
    assert!(c_ok.coherent());
    assert_eq!(
        c_ok.snapshot().map(|m| m.digest()),
        Some(snap.meta().digest())
    );
    assert!(c_ok.facts.unverified.contains(&UNVERIFIED_CURRENCY));
    // A/B mixing: the coherent candidate's needs over another snapshot's
    // reads (or over the edited ones) bind nothing — unknown, never a
    // number borrowed from the wrong response.
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    let mixed = widefees::reveal_needs(&c_ok, &other.reads()).unwrap();
    assert!(matches!(mixed.rent_lamports, Known::Unchecked(_)));
    assert!(matches!(mixed.funding, Funding::Unknown(_)));
    assert_eq!(mixed.snapshot_digest, None);
    let a = widereview::review_reveal(&c_ok, &other.reads(), &open);
    assert!(a.snapshot.is_none());
    assert!(a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(a.review.denials.contains(&Deny::FundingUnknown));
    assert!(!a.review.admitted);
    let a = widereview::review_reveal(&c_ok, &edited, &open);
    assert!(a.snapshot.is_none());
    assert!(a.review.denials.contains(&Deny::NoCoherentSnapshot));
    // And the edited candidate over the pristine reads: the candidate has
    // no snapshot, so the pristine reads bind nothing either.
    let a = widereview::review_reveal(&c_edited, &pristine, &open);
    assert!(a.snapshot.is_none());
    assert!(a.review.denials.contains(&Deny::NoCoherentSnapshot));
    // The matching pair binds.
    let a = widereview::review_reveal(&c_ok, &pristine, &open);
    assert_eq!(
        a.snapshot.as_ref().map(|m| m.digest()),
        Some(snap.meta().digest())
    );
    assert!(!a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(a.review.denials.contains(&Deny::SnapshotCurrencyUnknown));
    assert!(!a.review.admitted);
}

#[test]
fn snapshot_reveal_is_coherent_at_the_context_slot_and_the_fee_review_bounds_the_payer() {
    let fx = Fx::new();
    let pb = publication();
    // The payer in the fixture world holds one million lamports.
    let mut accounts = fx.reads().accounts;
    accounts.insert(
        payer(),
        Some(Account {
            lamports: 1_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let port = FakePort::new(accounts, clock_at(a_ts() + 10));
    let (c, snap) = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ))
    .unwrap();
    // Three ordinary rounds to learn the keys, then one snapshot at the
    // same requested minimum.
    assert_eq!(*port.min_slots.lock().unwrap(), vec![7, 7, 7]);
    assert_eq!(port.snapshot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert!(
        c.coherent(),
        "every account and the clock came from one response"
    );
    let meta = c.snapshot().expect("the snapshot meta");
    assert_eq!(meta.context_slot(), 900);
    assert_eq!(meta.min_slot(), 7);
    assert_eq!(c.min_slot, 7);
    assert_eq!(c.observed_clock, Some(clock_at(a_ts() + 10)));
    assert!(meta.rent_included());
    assert_eq!(meta.keys(), snap.accounts().len());
    assert!(
        snap.accounts().contains_key(&payer()),
        "the payer rides along for the fee review"
    );
    assert_eq!(meta.digest(), snap.meta().digest());
    assert!(c.facts.unverified.contains(&UNVERIFIED_CURRENCY));
    assert!(!c.facts.unverified.contains(&UNVERIFIED_COHERENCE));
    assert_eq!(c.instruction.accounts, fx.expected_accounts(0, true));
    assert_eq!(c.describe()["coherent"], true);
    assert_eq!(c.describe()["snapshot"]["current"], "unknown");
    assert_eq!(c.describe()["snapshot"]["source_complete"], false);
    // A stale response (the fake's context below the requested minimum)
    // is refused by the snapshot, not planned over.
    let r = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        901,
    ));
    assert!(matches!(r, Err(Block::Snapshot(ref s)) if s.contains("Stale")));
    // The fee review: the slot and the day are created (no displacement,
    // no day), their rent from the same response's Rent sysvar; the base
    // fee under one signature; the payer's balance at the context slot
    // falls short by the difference.
    let reads = snap.reads();
    let needs = widefees::reveal_needs(&c, &reads).unwrap();
    assert_eq!(
        needs.creates,
        vec![
            ("wide ArrivalSlot", wa::wide_arrival_slot::SIZE),
            ("wide ArrivalDay", wa::wide_arrival_day::SIZE)
        ]
    );
    let rent = (128 + 288) * 3_480 * 2 + (128 + 144) * 3_480 * 2;
    assert_eq!(needs.rent_lamports, Known::Known(rent));
    assert_eq!(needs.base_fee_lamports, Known::Known(5_000));
    assert_eq!(needs.signatures_assumed, 1);
    assert!(matches!(needs.priority_fee_lamports, Known::Unchecked(_)));
    assert!(!needs.budget_measured);
    assert_eq!(needs.required_lower_bound, Known::Known(rent + 5_000));
    assert_eq!(
        needs.funding,
        Funding::Unmet {
            payer_lamports: 1_000_000,
            required: rent + 5_000,
            short: rent + 5_000 - 1_000_000
        }
    );
    assert_eq!(needs.snapshot_digest, Some(meta.digest()));
    let d = needs.describe();
    assert_eq!(d["network_fee_at_send"], "not read");
    assert_eq!(d["future_balance"], "not proven");
    assert_eq!(d["live_fee_assurance"], false);
    // The full minimum is required even when the target address already
    // holds lamports: the fee review never nets a prefunded account.
    let mut prefunded = snap.reads();
    prefunded.accounts.insert(
        wide_slot_addr0(),
        Some(Account {
            lamports: 1_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let n = widefees::reveal_needs(&c, &prefunded).unwrap();
    assert!(
        matches!(n.rent_lamports, Known::Unchecked(_)),
        "edited reads are no longer the candidate's snapshot: nothing is netted, nothing is calculated"
    );
    // The review bound to the candidate and its reads: the coherent
    // snapshot replaces the no-snapshot denial with the currency one; the
    // funding shortfall is a denial; everything else stays; admitted
    // stays false.
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    let a = widereview::review_reveal(&c, &reads, &open);
    assert_eq!(a.snapshot.as_ref().map(|m| m.digest()), Some(meta.digest()));
    assert_eq!(a.needs.as_ref().map(|n| n.funding), Some(needs.funding));
    let r = a.review;
    assert!(!r.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(r.denials.contains(&Deny::SnapshotCurrencyUnknown));
    assert!(r.denials.contains(&Deny::FundingUnmet));
    for d in [
        Deny::SourceUnproven,
        Deny::HistoryUnknown,
        Deny::ExecutionEvidenceUnverified,
        Deny::SignerAbsent,
        Deny::SliceDoesNotEnqueue,
    ] {
        assert!(r.denials.contains(&d), "{d:?}");
    }
    assert!(!r.admitted);
    // A funded payer meets the lower bound; the review still denies on
    // everything else, and a met bound is never an execution grant.
    let mut accounts = fx.reads().accounts;
    accounts.insert(
        payer(),
        Some(Account {
            lamports: 10_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let port = FakePort::new(accounts, clock_at(a_ts() + 10));
    let (c2, snap2) = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ))
    .unwrap();
    let needs2 = widefees::reveal_needs(&c2, &snap2.reads()).unwrap();
    assert_eq!(
        needs2.funding,
        Funding::MetLowerBound {
            payer_lamports: 10_000_000,
            required: rent + 5_000
        }
    );
    let r2 = widereview::review_reveal(&c2, &snap2.reads(), &open).review;
    assert!(
        !r2.denials.contains(&Deny::FundingUnmet) && !r2.denials.contains(&Deny::FundingUnknown)
    );
    assert!(r2.denials.contains(&Deny::SnapshotCurrencyUnknown));
    assert!(
        r2.denials.contains(&Deny::ExecutionEvidenceUnverified),
        "a met lower bound is never a live fee assurance"
    );
    assert!(!r2.admitted);
    assert_eq!(r2.denials.len(), 6);
    // No Rent in the snapshot while accounts would be created: the rent
    // and the funding are declared unknown, never guessed.
    let mut port = FakePort::new(fx.reads().accounts, clock_at(a_ts() + 10));
    port.rent = None;
    let r = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ));
    assert!(matches!(r, Err(Block::Snapshot(ref s)) if s.contains("BadRent")));
    // Ordinary reads (no snapshot): the fee review knows nothing of rent
    // or funding, and the review denies with `NoCoherentSnapshot` and
    // `FundingUnknown`.
    let plain = fx.plan().unwrap();
    let needs3 = widefees::reveal_needs(&plain, &fx.reads()).unwrap();
    assert!(matches!(needs3.rent_lamports, Known::Unchecked(_)));
    assert!(matches!(needs3.funding, Funding::Unknown(_)));
    let r3 = widereview::review_reveal(&plain, &fx.reads(), &open).review;
    assert!(r3.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(r3.denials.contains(&Deny::FundingUnknown));
    assert!(!r3.admitted);
    // A snapshot whose state moved between learning the keys and the one
    // response (a slot appeared, so the plan asks for nothing new; here a
    // key missing from the response): refused, never patched.
    struct Shrinking(FakePort);
    impl ChainPort for Shrinking {
        fn clock(&self) -> impl Future<Output = PortResult<ClockSysvar>> + Send {
            self.0.clock()
        }
        fn accounts(
            &self,
            keys: &[Address],
            min_slot: u64,
        ) -> impl Future<Output = PortResult<Vec<Option<Account>>>> + Send {
            self.0.accounts(keys, min_slot)
        }
        fn simulate(&self, tx: &[u8]) -> impl Future<Output = PortResult<SimResult>> + Send {
            self.0.simulate(tx)
        }
        fn send(&self, tx: &[u8]) -> impl Future<Output = PortResult<Signature>> + Send {
            self.0.send(tx)
        }
        fn statuses(
            &self,
            sigs: &[Signature],
        ) -> impl Future<Output = PortResult<Vec<Option<Status>>>> + Send {
            self.0.statuses(sigs)
        }
        fn feed(&self, after: Cursor) -> impl Future<Output = PortResult<Vec<TxRecord>>> + Send {
            self.0.feed(after)
        }
        fn blockhash(&self) -> impl Future<Output = PortResult<(Hash, u64)>> + Send {
            self.0.blockhash()
        }
    }
    impl SnapshotPort for Shrinking {
        fn snapshot(
            &self,
            keys: &[Address],
            with_rent: bool,
            min_slot: u64,
        ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
            // The response drops the destination province: the plan over
            // it asks for a key the response does not hold.
            let kept: Vec<Address> = keys
                .iter()
                .copied()
                .filter(|k| *k != province_addr(home()))
                .collect();
            let r = parse_snapshot_response(
                &self.0.snapshot_json(&kept, with_rent),
                &kept,
                with_rent,
                min_slot,
            );
            async move { r }
        }
    }
    let port = Shrinking(FakePort::new(fx.reads().accounts, clock_at(a_ts() + 10)));
    let r = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ));
    assert_eq!(
        blocked(r.map(|(c, _)| c)),
        Err(Block::SnapshotIncomplete(1))
    );
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
    // The review of this candidate with the reads it was planned over
    // (ordinary reads: no snapshot binds) — the same denials plus the
    // funding one; never admitted.
    let a = widereview::review_reveal(&c, &fx.reads(), &open);
    assert!(a.snapshot.is_none());
    assert!(a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(a.review.denials.contains(&Deny::FundingUnknown));
    assert!(!a.review.admitted);
    assert_eq!(a.describe()["review"]["enqueued"], false);
    // (The settle candidate's subject key is checked in `wide_duties.rs`,
    // where a planner-made settle candidate exists; a `Candidate` cannot be
    // assembled by hand here, which is the point.)
}

/// What a coherent, funded reveal candidate loses the moment any of its
/// public fields differs from what the planner produced: the snapshot, the
/// coherence, the calculated rent and funding, the bound review — even over
/// the very reads that still verify as its snapshot.
fn lost_everything(label: &str, m: &RevealCandidate, reads: &Reads, open: &EngineView) {
    assert!(
        reads.coherent_snapshot().is_some(),
        "{label}: the reads themselves still verify; it is the candidate that no longer matches"
    );
    assert!(!m.coherent(), "{label}: coherent");
    assert!(m.snapshot().is_none(), "{label}: snapshot");
    assert_eq!(m.describe()["coherent"], false, "{label}: describe");
    assert!(
        m.describe()["snapshot"].is_null(),
        "{label}: described snapshot"
    );
    let n = widefees::reveal_needs(m, reads).unwrap();
    assert!(
        matches!(n.rent_lamports, Known::Unchecked(_)),
        "{label}: rent {:?}",
        n.rent_lamports
    );
    assert!(
        matches!(n.required_lower_bound, Known::Unchecked(_)),
        "{label}: bound"
    );
    assert!(
        matches!(n.funding, Funding::Unknown(_)),
        "{label}: funding {:?}",
        n.funding
    );
    assert_eq!(n.snapshot_digest, None, "{label}: digest");
    let a = widereview::review_reveal(m, reads, open);
    assert!(a.snapshot.is_none(), "{label}: assessment snapshot");
    assert!(
        a.review.denials.contains(&Deny::NoCoherentSnapshot),
        "{label}: denial"
    );
    assert!(
        a.review.denials.contains(&Deny::FundingUnknown),
        "{label}: funding denial"
    );
    assert!(
        !a.review.denials.contains(&Deny::FundingUnmet),
        "{label}: no number was borrowed"
    );
    assert!(!a.review.admitted, "{label}: admitted");
}

#[test]
fn a_mutated_reveal_candidate_loses_its_snapshot_fee_bound_and_review() {
    let fx = Fx::new();
    let pb = publication();
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    // A funded payer: the pristine candidate meets its lower bound, so a
    // wrong fee review over mutated facts would be visible as a wrong
    // number (a day or a slot not created: rent 0) — it must be no number.
    let mut accounts = fx.reads().accounts;
    accounts.insert(
        payer(),
        Some(Account {
            lamports: 10_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let port = FakePort::new(accounts, clock_at(a_ts() + 10));
    let (c, snap) = block_on(widereveal::reveal_snapshot(
        &port,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ))
    .unwrap();
    let reads = snap.reads();
    assert!(c.coherent());
    assert!(
        !c.facts.day_present && c.facts.displaced.is_none(),
        "the fixture creates both"
    );
    let rent = (128 + 288) * 3_480 * 2 + (128 + 144) * 3_480 * 2;
    let pristine = widefees::reveal_needs(&c, &reads).unwrap();
    assert_eq!(pristine.rent_lamports, Known::Known(rent));
    assert_eq!(
        pristine.funding,
        Funding::MetLowerBound {
            payer_lamports: 10_000_000,
            required: rent + 5_000
        }
    );
    let a = widereview::review_reveal(&c, &reads, &open);
    assert_eq!(
        a.snapshot.as_ref().map(|m| m.digest()),
        Some(snap.meta().digest())
    );
    assert!(!a.review.denials.contains(&Deny::NoCoherentSnapshot));
    assert!(!a.review.denials.contains(&Deny::FundingUnknown));
    assert!(
        !a.review.admitted,
        "a bound, funded candidate is still never admitted"
    );
    // An untouched clone is the same candidate.
    let same = c.clone();
    assert!(same.coherent());
    assert_eq!(
        same.snapshot().map(|m| m.digest()),
        Some(snap.meta().digest())
    );
    assert_eq!(widefees::reveal_needs(&same, &reads).unwrap(), pristine);
    // Facts: the day said present (would drop the day's rent).
    let mut m = c.clone();
    m.facts.day_present = true;
    lost_everything("day_present", &m, &reads, &open);
    // Facts: a displacement claimed (would drop the slot's rent).
    let mut m = c.clone();
    m.facts.displaced = Some(host_b());
    lost_everything("displaced", &m, &reads, &open);
    // Facts: any other field — the day bit, the target, the arrival bell,
    // the crypto label, the publication's verified flag, the source's
    // signature, the unverified lines.
    let mut m = c.clone();
    m.facts.day_bit_set = !m.facts.day_bit_set;
    lost_everything("day_bit_set", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.target_i ^= 1;
    lost_everything("target_i", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.arrive_bell += 1;
    lost_everything("arrive_bell", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.crypto = Crypto::IbeOpened;
    lost_everything("crypto", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.publication.signature_verified = !m.facts.publication.signature_verified;
    lost_everything("publication", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.source.signature[0] ^= 1;
    lost_everything("source", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.unverified.clear();
    lost_everything("unverified", &m, &reads, &open);
    // The fee payer (the funding would be read for another account).
    let mut m = c.clone();
    m.fee_payer = beneficiary();
    lost_everything("fee_payer", &m, &reads, &open);
    let mut m = c.clone();
    m.beneficiary = payer();
    lost_everything("beneficiary", &m, &reads, &open);
    // The instruction: program, data, an account's key, signer flag,
    // writable flag, one account fewer, one more.
    let mut m = c.clone();
    m.instruction.program_id = beneficiary();
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
    m.instruction.accounts[0].pubkey = beneficiary();
    lost_everything("accounts[0].pubkey", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[0].is_signer = false;
    lost_everything("accounts[0].is_signer", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts[1].is_writable = !m.instruction.accounts[1].is_writable;
    lost_everything("accounts[1].is_writable", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts.pop();
    lost_everything("accounts fewer", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction
        .accounts
        .push(AccountMeta::new_readonly(beneficiary(), false));
    lost_everything("accounts more", &m, &reads, &open);
    let mut m = c.clone();
    m.instruction.accounts.swap(2, 3);
    lost_everything("accounts reordered", &m, &reads, &open);
    // The observed metadata: the slot bound, the clock (changed, dropped),
    // the status flag.
    let mut m = c.clone();
    m.min_slot = 8;
    lost_everything("min_slot", &m, &reads, &open);
    let mut m = c.clone();
    m.observed_clock = Some(clock_at(a_ts() + 11));
    lost_everything("observed_clock", &m, &reads, &open);
    let mut m = c.clone();
    m.observed_clock = None;
    lost_everything("observed_clock dropped", &m, &reads, &open);
    let mut m = c.clone();
    m.status_promoted_by_clock = !m.status_promoted_by_clock;
    lost_everything("status_promoted_by_clock", &m, &reads, &open);
    // The always-false flags are content too: a flipped `signed` or
    // `automatic_send` is not the planner's candidate (and the review
    // never read them to begin with: still unsigned, still not enqueued).
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
    let a = widereview::review_reveal(&m, &reads, &open);
    assert!(!a.review.admitted);
    assert!(a.review.denials.contains(&Deny::SignerAbsent));
    assert!(a.review.denials.contains(&Deny::SliceDoesNotEnqueue));
    // A/B mixing. Candidate B is planned over another response (the payer
    // at five lamports, otherwise the same bytes): both are coherent on
    // their own, neither over the other's reads, and a candidate carrying
    // A's facts with B's payer balance in mind is not constructible — the
    // content of A over the reads of B binds nothing.
    let mut accounts_b = fx.reads().accounts;
    accounts_b.insert(
        payer(),
        Some(Account {
            lamports: 5,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let port_b = FakePort::new(accounts_b, clock_at(a_ts() + 10));
    let (cb, snap_b) = block_on(widereveal::reveal_snapshot(
        &port_b,
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        7,
    ))
    .unwrap();
    let reads_b = snap_b.reads();
    assert_ne!(snap.meta().digest(), snap_b.meta().digest());
    assert!(cb.coherent());
    assert_eq!(cb.facts, c.facts, "the same plan over the same game bytes");
    assert_eq!(cb.instruction, c.instruction);
    let nb = widefees::reveal_needs(&cb, &reads_b).unwrap();
    assert_eq!(
        nb.funding,
        Funding::Unmet {
            payer_lamports: 5,
            required: rent + 5_000,
            short: rent + 5_000 - 5
        }
    );
    // A over B's reads, B over A's reads: unknown, never the other's number.
    for (label, cand, other) in [("A over B", &c, &reads_b), ("B over A", &cb, &reads)] {
        let n = widefees::reveal_needs(cand, other).unwrap();
        assert!(matches!(n.funding, Funding::Unknown(_)), "{label}");
        assert_eq!(n.snapshot_digest, None, "{label}");
        let a = widereview::review_reveal(cand, other, &open);
        assert!(a.snapshot.is_none(), "{label}");
        assert!(
            a.review.denials.contains(&Deny::NoCoherentSnapshot),
            "{label}"
        );
        assert!(a.review.denials.contains(&Deny::FundingUnknown), "{label}");
        assert!(!a.review.denials.contains(&Deny::FundingUnmet), "{label}");
    }
    // A mutated B over A's reads, a mutated A over B's reads: still nothing.
    let mut mb = cb.clone();
    mb.facts.day_present = true;
    let n = widefees::reveal_needs(&mb, &reads).unwrap();
    assert!(matches!(n.funding, Funding::Unknown(_)));
    assert!(!mb.coherent());
    let mut ma = c.clone();
    ma.fee_payer = beneficiary();
    assert!(!ma.coherent());
    assert!(widereview::review_reveal(&ma, &reads_b, &open)
        .review
        .denials
        .contains(&Deny::NoCoherentSnapshot));
    // The pristine pair still binds after all of this: nothing above was a
    // side effect on `c`, `reads` or the snapshot.
    assert!(c.coherent());
    assert_eq!(widefees::reveal_needs(&c, &reads).unwrap(), pristine);
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
fn world_bytes_past_the_debug_prefix_are_reveal_candidate_content() {
    // `WorldId`'s Debug prints four of its 32 bytes; the content digest
    // hashes the full ABI bytes of every identity.
    assert_eq!(format!("{:?}", rehost(host(), 5)), format!("{:?}", host()));
    assert_ne!(rehost(host(), 5), host());
    let open = EngineView {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    };
    // A displacing arrival (the same Citizen's smaller host in slot 3), the
    // payer funded, planned over one parsed response.
    let mut fx = Fx::new();
    fx.slots[3] = Some(slot_bytes(3, host_b(), citizen(), TROOPS - 1));
    let pb = publication();
    let mut accounts = fx.reads().accounts;
    accounts.insert(
        payer(),
        Some(Account {
            lamports: 10_000_000,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        }),
    );
    let mut keys: Vec<Address> = accounts.keys().copied().collect();
    keys.sort();
    keys.dedup();
    let port = FakePort::new(accounts, clock_at(a_ts() + 10));
    let snap = parse_snapshot_response(&port.snapshot_json(&keys, true), &keys, true, 7).unwrap();
    let reads = snap.reads();
    let c = match widereveal::plan_reveal(
        &scope(),
        payer(),
        beneficiary(),
        &fx.proof,
        Some(&fx.opening),
        Some(&pb),
        &reads,
    ) {
        Step::Done(r) => r.unwrap(),
        Step::Need(a) => panic!("{a:?}"),
    };
    assert!(c.coherent());
    assert_eq!((c.facts.target_i, c.facts.displaced), (3, Some(host_b())));
    assert!(c.facts.path_provinces.is_empty());
    let pristine = widefees::reveal_needs(&c, &reads).unwrap();
    // A displacement reuses the slot: only the day is created.
    assert_eq!(
        pristine.creates,
        vec![("wide ArrivalDay", wa::wide_arrival_day::SIZE)]
    );
    assert!(matches!(pristine.funding, Funding::MetLowerBound { .. }));
    // The host's, the destination's and the displaced host's worlds, each
    // at bytes past the Debug prefix; the instruction untouched.
    for i in [4usize, 5, 17, 31] {
        let mut m = c.clone();
        m.facts.host = rehost(m.facts.host, i);
        assert_eq!(m.instruction, c.instruction);
        assert_eq!(
            format!("{:?}", m.facts),
            format!("{:?}", c.facts),
            "Debug cannot tell"
        );
        lost_everything(&format!("host world[{i}]"), &m, &reads, &open);
        let mut m = c.clone();
        m.facts.dest = rekey(m.facts.dest, i);
        assert_eq!(m.instruction, c.instruction);
        assert_eq!(
            format!("{:?}", m.facts),
            format!("{:?}", c.facts),
            "Debug cannot tell"
        );
        lost_everything(&format!("dest world[{i}]"), &m, &reads, &open);
        let mut m = c.clone();
        m.facts.displaced = Some(rehost(host_b(), i));
        assert_eq!(m.instruction, c.instruction);
        assert_eq!(
            format!("{:?}", m.facts),
            format!("{:?}", c.facts),
            "Debug cannot tell"
        );
        lost_everything(&format!("displaced world[{i}]"), &m, &reads, &open);
    }
    // A path province of a look-alike world (the fixture's path is empty:
    // a path at all is a change, and so is its world).
    let mut m = c.clone();
    m.facts.path_provinces = vec![rekey(away(), 9)];
    assert_eq!(m.instruction, c.instruction);
    lost_everything("path province", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.path_provinces = vec![away()];
    lost_everything("path province (same world)", &m, &reads, &open);
    // The source's slot and sequence, the window, the travel time, the
    // budget-policy label: every remaining fact, once.
    let mut m = c.clone();
    m.facts.source.seq += 1;
    lost_everything("source.seq", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.source.slot += 1;
    lost_everything("source.slot", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.source.instruction_index += 1;
    lost_everything("source.instruction_index", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.source.signatures_verified = true;
    lost_everything("source.signatures_verified", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.source.method = "another method";
    lost_everything("source.method", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.window.judged_at += 1;
    lost_everything("window.judged_at", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.window.seed_round += 1;
    lost_everything("window.seed_round", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.publication.round += 1;
    lost_everything("publication.round", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.publication.pk_hash[31] ^= 1;
    lost_everything("publication.pk_hash", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.travel_secs += 1;
    lost_everything("travel_secs", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.transit_slot ^= 1;
    lost_everything("transit_slot", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.dest_tile ^= 1;
    lost_everything("dest_tile", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.region ^= 1;
    lost_everything("region", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.budget_prefix_policy = "another policy";
    lost_everything("budget_prefix_policy", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.unverified.push("one more line");
    lost_everything("unverified appended", &m, &reads, &open);
    let mut m = c.clone();
    m.facts.unverified.swap(0, 1);
    lost_everything("unverified reordered", &m, &reads, &open);
    // The flags, each alone.
    let mut m = c.clone();
    m.signed = true;
    lost_everything("signed", &m, &reads, &open);
    let mut m = c.clone();
    m.automatic_send = true;
    lost_everything("automatic_send", &m, &reads, &open);
    // Flipped back: the planner's bytes again.
    let mut m = c.clone();
    m.facts.host = rehost(rehost(m.facts.host, 9), 9);
    assert!(m.coherent());
    assert!(c.coherent());
    assert_eq!(widefees::reveal_needs(&c, &reads).unwrap(), pristine);
}

// ------------------------------------------------------------ the tick's reveal

/// A drand port serving literal shipped rounds (counting the asks).
struct FakeDrand {
    rounds: BTreeMap<u64, [u8; 48]>,
    asks: AtomicUsize,
}
impl DrandPort for FakeDrand {
    async fn round(&self, r: u64) -> PortResult<Option<Beacon>> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        Ok(self.rounds.get(&r).map(|s| Beacon {
            round: r,
            sig48: *s,
        }))
    }
    fn info(&self) -> ChainInfo {
        beacon::quicknet_info()
    }
}

/// The fake port behind an `Arc`, as a snapshot source the test can still
/// inspect (a `SnapshotSource` through the blanket impl); records the
/// keys of every request.
struct SharedPort(std::sync::Arc<FakePort>);
impl FakePort {
    fn snapshot_keys_contain(&self, k: &Address) -> bool {
        self.snapshot_keys
            .lock()
            .unwrap()
            .iter()
            .any(|ks| ks.contains(k))
    }
}
impl SnapshotPort for SharedPort {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        self.0.snapshot_calls.fetch_add(1, Ordering::SeqCst);
        self.0.snapshot_keys.lock().unwrap().push(keys.to_vec());
        let r = parse_snapshot_response(
            &self.0.snapshot_json(keys, with_rent),
            keys,
            with_rent,
            min_slot,
        );
        async move { r }
    }
}

/// The tick plans a reveal only from a stored proof, a publication the
/// review's own cache verified under the pinned key, and the public
/// `FromBeacon` opening; over one snapshot response when a source is
/// attached; it holds and shows no plaintext, salt or key; it enqueues
/// nothing.
#[test]
fn the_tick_reviews_a_reveal_only_from_a_stored_proof_a_verified_beacon_and_the_public_opening() {
    let (ibe, k) = recorded_vector();
    let pt = plain_for(host(), ARRIVE_BELL);
    let plain = wseal::pack(&pt);
    let seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &plain));
    let salt = salt_of(&k);
    let fx = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    let season = Season::decode(&fx.season).unwrap();
    let (round, sig) = vector();
    assert_eq!(
        fclient::clock::SeasonClock::from_season(&season).tlock_round(ARRIVE_BELL),
        round,
        "the runtime's season names the vector's round"
    );
    let model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: nothing observed".into(),
        },
        Limits::default(),
    );
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let mut clock = clock_at(a_ts() + 10);
    // Same-response state must be at least as new as the departure proof.
    clock.slot = fx.proof.provenance.slot;
    let port = FakePort::new(fx.reads().accounts, clock);
    let drand = FakeDrand {
        rounds: BTreeMap::from([(round, sig)]),
        asks: AtomicUsize::new(0),
    };
    let mut cache = BeaconCache::new(pk96());
    assert_eq!(cache.pk_hash(), season.quicknet_pk_hash);
    let deployment = Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    };
    // Without a stored proof nothing is listed, inputs or not; the status
    // names the gap; the beacon is not asked.
    let mut review = WideReview::new(deployment);
    let made = block_on(async {
        let mut pubs = DrandPublications {
            drand: &drand,
            cache: &mut cache,
        };
        review
            .step(
                &port,
                &engine,
                &model,
                program(),
                season_pda().0,
                7,
                None,
                Some(RevealInputs {
                    season: &season,
                    beacon: &mut pubs,
                    beneficiary: beneficiary(),
                }),
            )
            .await
    });
    assert_eq!(made, 0);
    assert_eq!(drand.asks.load(Ordering::SeqCst), 0);
    let st = review.status();
    assert_eq!(st["reveal"]["inputs_at_last_step"], true);
    assert!(st["missing"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m.as_str().unwrap().starts_with("departure proofs")));
    // The fixture proof supplied (labelled so; a forged provenance claim
    // is normalised away), no snapshot source: one reveal plan over
    // ordinary reads, the publication fetched once and verified, the seal
    // opened from it, the candidate non-coherent.
    let mut forged = fx.proof.clone();
    forged.provenance.signatures_verified = true;
    forged.provenance.method = "attacker: verified by nobody";
    assert!(review.proofs.supply(forged));
    assert!(
        !review
            .proofs
            .get(host(), SLOT)
            .unwrap()
            .proof
            .provenance
            .signatures_verified
    );
    let made = block_on(async {
        let mut pubs = DrandPublications {
            drand: &drand,
            cache: &mut cache,
        };
        review
            .step(
                &port,
                &engine,
                &model,
                program(),
                season_pda().0,
                7,
                None,
                Some(RevealInputs {
                    season: &season,
                    beacon: &mut pubs,
                    beneficiary: beneficiary(),
                }),
            )
            .await
    });
    assert_eq!(made, 1);
    assert_eq!(
        (
            review.reveal_plans,
            review.reveal_candidates,
            review.coherent
        ),
        (1, 1, 0)
    );
    assert_eq!(drand.asks.load(Ordering::SeqCst), 1);
    assert_eq!((cache.fetched, cache.bad, cache.len()), (1, 0, 1));
    let st = review.status();
    let r = &st["recent"][0];
    assert_eq!(r["outcome"], "candidate");
    assert_eq!(r["proof_origin"], ORIGIN_SUPPLIED);
    assert_eq!(r["publication_round"], round);
    assert_eq!(r["publication_served"], true);
    assert_eq!(r["opening"], "FromBeacon");
    assert_eq!(r["candidate"]["crypto"], "IbeOpened");
    assert_eq!(r["candidate"]["publication_signature_verified"], true);
    assert_eq!(r["candidate"]["source_signatures_verified"], false);
    assert_eq!(r["candidate"]["coherent"], false);
    assert_eq!(r["candidate"]["fee_payer"], Address::default().to_string());
    assert_eq!(r["candidate"]["signed"], false);
    assert_eq!(r["candidate"]["automatic_send"], false);
    let rv = &r["assessment"]["review"];
    assert_eq!(rv["admitted"], false);
    assert_eq!(rv["enqueued"], false);
    let denials = rv["denials"].as_array().unwrap();
    for d in [
        "SourceUnproven",
        "NoCoherentSnapshot",
        "HistoryUnknown",
        "ExecutionEvidenceUnverified",
        "SignerAbsent",
        "SliceDoesNotEnqueue",
        "FundingUnknown",
    ] {
        assert!(denials.iter().any(|x| x == d), "{d}");
    }
    // Nothing secret or opened is in the status: not the plaintext, not
    // the salt, not the recorded `k`.
    let text = st.to_string();
    assert!(!text.contains(&hex::encode(plain)));
    assert!(!text.contains(&hex::encode(salt)));
    assert!(!text.contains(&hex::encode(k)));
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(st["enqueued"], 0);
    // Within the refresh window the same hint is not planned again and the
    // beacon is served from the cache if it were.
    let made = block_on(async {
        let mut pubs = DrandPublications {
            drand: &drand,
            cache: &mut cache,
        };
        review
            .step(
                &port,
                &engine,
                &model,
                program(),
                season_pda().0,
                8,
                None,
                Some(RevealInputs {
                    season: &season,
                    beacon: &mut pubs,
                    beneficiary: beneficiary(),
                }),
            )
            .await
    });
    assert_eq!(made, 0);
    assert_eq!(drand.asks.load(Ordering::SeqCst), 1);
    // With a snapshot source: the same plan over one response, coherent
    // at its context slot, the Rent in the response (a reveal creates),
    // no payer set so funding unknown; one snapshot request.
    let shared = std::sync::Arc::new(FakePort::new(fx.reads().accounts, clock));
    let shared_src = SharedPort(shared.clone());
    let mut review2 = WideReview::new(deployment);
    assert!(review2.proofs.supply(fx.proof.clone()));
    let made = block_on(async {
        let mut pubs = DrandPublications {
            drand: &drand,
            cache: &mut cache,
        };
        review2
            .step(
                &port,
                &engine,
                &model,
                program(),
                season_pda().0,
                7,
                Some(&shared_src),
                Some(RevealInputs {
                    season: &season,
                    beacon: &mut pubs,
                    beneficiary: beneficiary(),
                }),
            )
            .await
    });
    assert_eq!(made, 1);
    assert_eq!(
        (
            review2.reveal_candidates,
            review2.coherent,
            review2.snapshot_blocked
        ),
        (1, 1, 0)
    );
    assert_eq!(shared.snapshot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        drand.asks.load(Ordering::SeqCst),
        1,
        "served from the review's cache"
    );
    let st2 = review2.status();
    assert!(st2["snapshot"]["source"]
        .as_str()
        .unwrap()
        .starts_with("SnapshotPort"));
    assert_eq!(st2["snapshot"]["coherent_candidates"], 1);
    let r2 = &st2["recent"][0];
    assert_eq!(r2["candidate"]["coherent"], true);
    assert_eq!(r2["candidate"]["crypto"], "IbeOpened");
    assert_eq!(r2["snapshot"]["context_slot"], fx.proof.provenance.slot);
    assert_eq!(r2["snapshot"]["min_slot"], fx.proof.provenance.slot);
    assert_eq!(r2["snapshot"]["rent_included"], true);
    assert_eq!(
        r2["assessment"]["snapshot"]["digest"], r2["snapshot"]["digest"],
        "the assessment is bound to the very response"
    );
    let denials2 = r2["assessment"]["review"]["denials"].as_array().unwrap();
    assert!(!denials2.iter().any(|d| d == "NoCoherentSnapshot"));
    assert!(denials2.iter().any(|d| d == "SnapshotCurrencyUnknown"));
    assert!(
        denials2.iter().any(|d| d == "FundingUnknown")
            && !denials2.iter().any(|d| d == "FundingUnmet"),
        "no payer set: the placeholder is not a wallet"
    );
    assert!(
        !shared.snapshot_keys_contain(&Address::default()),
        "the placeholder is not requested"
    );
    assert!(denials2.iter().any(|d| d == "SourceUnproven"));
    assert!(denials2.iter().any(|d| d == "HistoryUnknown"));
    assert_eq!(r2["assessment"]["review"]["admitted"], false);
    let rent = (128 + 288) * 3_480 * 2 + (128 + 144) * 3_480 * 2;
    assert_eq!(r2["assessment"]["needs"]["rent_lamports"], rent);
    assert!(!st2.to_string().contains(&hex::encode(plain)));
    assert_eq!(engine.pending_len(), 0);
    assert_eq!(port.forbidden.load(Ordering::SeqCst), 0);
    assert_eq!(shared.forbidden.load(Ordering::SeqCst), 0);
    // A beacon not served: the publication is missing, the plan is
    // blocked at the gate before anything destination-bearing is read, and
    // the round is asked once per slot.
    let empty = FakeDrand {
        rounds: BTreeMap::new(),
        asks: AtomicUsize::new(0),
    };
    let mut cache3 = BeaconCache::new(pk96());
    let mut review3 = WideReview::new(deployment);
    assert!(review3.proofs.supply(fx.proof.clone()));
    let made = block_on(async {
        let mut pubs = DrandPublications {
            drand: &empty,
            cache: &mut cache3,
        };
        review3
            .step(
                &port,
                &engine,
                &model,
                program(),
                season_pda().0,
                7,
                None,
                Some(RevealInputs {
                    season: &season,
                    beacon: &mut pubs,
                    beneficiary: beneficiary(),
                }),
            )
            .await
    });
    assert_eq!(made, 1);
    assert_eq!(
        (
            review3.reveal_candidates,
            review3.blocked,
            review3.publications_missing
        ),
        (0, 1, 1)
    );
    let r3 = &review3.status()["recent"][0];
    assert_eq!(r3["outcome"], "blocked");
    assert_eq!(r3["block"], "PublicationMissing");
    assert_eq!(r3["publication_served"], false);
    assert_eq!(empty.asks.load(Ordering::SeqCst), 1);
    assert!(block_on(cache3.publication(&empty, round, 7)).is_none());
    assert_eq!(empty.asks.load(Ordering::SeqCst), 1, "once per slot");
    assert!(block_on(cache3.publication(&empty, round, 8)).is_none());
    assert_eq!(
        empty.asks.load(Ordering::SeqCst),
        2,
        "a new slot asks again"
    );
    assert_eq!((cache3.asks, cache3.fetched, cache3.bad), (2, 0, 0));
    // A served round whose signature does not verify under the pinned
    // key is counted and never used; another real round's signature under
    // the vector's number is likewise refused.
    let mut corrupt = sig;
    corrupt[0] ^= 1;
    let bad = FakeDrand {
        rounds: BTreeMap::from([(round, corrupt)]),
        asks: AtomicUsize::new(0),
    };
    let mut cache4 = BeaconCache::new(pk96());
    assert!(block_on(cache4.publication(&bad, round, 1)).is_none());
    assert_eq!((cache4.bad, cache4.fetched, cache4.len()), (1, 0, 0));
    let other_sig = {
        let f = FixtureDrand::load(&beacon::fixture_dir(), beacon::quicknet_info()).unwrap();
        f.rounds
            .iter()
            .nth(1)
            .expect("a second shipped round")
            .1
            .sig48
    };
    let swapped = FakeDrand {
        rounds: BTreeMap::from([(round, other_sig)]),
        asks: AtomicUsize::new(0),
    };
    assert!(block_on(cache4.publication(&swapped, round, 2)).is_none());
    assert_eq!(cache4.bad, 2);
    // The real one verifies and is cached: the second call does not ask.
    let p = block_on(cache4.publication(&drand, round, 3)).expect("verified");
    assert_eq!((p.round, p.sig48, p.pk96), (round, sig, pk96()));
    let asks = drand.asks.load(Ordering::SeqCst);
    assert_eq!(block_on(cache4.publication(&drand, round, 4)), Some(p));
    assert_eq!(drand.asks.load(Ordering::SeqCst), asks);
    // Without reveal inputs the stored proof yields no hint at all.
    let mut review5 = WideReview::new(deployment);
    assert!(review5.proofs.supply(fx.proof.clone()));
    let made = block_on(review5.step(
        &port,
        &engine,
        &model,
        program(),
        season_pda().0,
        7,
        None,
        None,
    ));
    assert_eq!(made, 0);
    let st5 = review5.status();
    assert_eq!(st5["reveal"]["inputs_at_last_step"], false);
    assert_eq!(st5["reveal"]["proofs"]["held"], 1);
    assert!(st5["missing"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m.as_str().unwrap().starts_with("reveal inputs")));
    assert_eq!(engine.pending_len(), 0);
}

/// A reveal blocked on a readiness the next slot may bring (THE anchor not
/// landed, no clock, the Season not started, the publication not served)
/// is retried at the next slot and becomes a candidate as soon as the
/// chain is ready; a closed window or an existing reveal is not retried
/// before the full refresh. The retry is bounded elsewhere
/// (`MAX_TRANSIENT_RETRIES`); nothing here spins.
#[test]
fn reveal_readiness_blocks_retry_next_slot_while_closed_windows_wait() {
    // The classification itself.
    for b in [
        Block::PublicationMissing,
        Block::AnchorRequired("absent"),
        Block::AnchorRequired("archive-only"),
        Block::TimingNeedsClock,
        Block::SeasonNotStarted {
            genesis_ts: 2,
            observed: 1,
        },
        Block::SeasonDependsOnClock,
        Block::Read("x".into()),
        Block::ReadLoop,
        Block::Snapshot("Stale(1,2)".into()),
        Block::SnapshotIncomplete(1),
    ] {
        assert!(is_transient(&b), "{b:?}");
    }
    for b in [
        Block::WindowClosed("clock"),
        Block::AlreadyRevealed,
        Block::BeaconKey,
        Block::BeaconSignatureInvalid,
        Block::CommitMismatch,
        Block::SealOpen("x".into()),
        Block::LatchClosed("x"),
        Block::QuotaRefused("full"),
        Block::SeasonEnded,
        Block::NoOpening,
        Block::Shielded,
    ] {
        assert!(!is_transient(&b), "{b:?}");
    }
    // The recorded vector's march, the publication served and verified.
    let (ibe, k) = recorded_vector();
    let pt = plain_for(host(), ARRIVE_BELL);
    let plain = wseal::pack(&pt);
    let seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &plain));
    let salt = salt_of(&k);
    let fx = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    let season = Season::decode(&fx.season).unwrap();
    let (round, sig) = vector();
    let model = WideDiscovery::new(
        IndexScope {
            program: program(),
            season: season_pda().0,
            world: world(),
            source: "test: nothing observed".into(),
        },
        Limits::default(),
    );
    let engine = Engine::new(Budgets::default(), EngineParams::default());
    let drand = FakeDrand {
        rounds: BTreeMap::from([(round, sig)]),
        asks: AtomicUsize::new(0),
    };
    let mut cache = BeaconCache::new(pk96());
    let deployment = Deployment {
        program_version: WIDE_VERSION,
        ruleset_hash: RULESET,
    };
    let clock = clock_at(a_ts() + 10);
    let step = |review: &mut WideReview, port: &FakePort, cache: &mut BeaconCache, slot: u64| {
        block_on(async {
            let mut pubs = DrandPublications {
                drand: &drand,
                cache,
            };
            review
                .step(
                    port,
                    &engine,
                    &model,
                    program(),
                    season_pda().0,
                    slot,
                    None,
                    Some(RevealInputs {
                        season: &season,
                        beacon: &mut pubs,
                        beneficiary: beneficiary(),
                    }),
                )
                .await
        })
    };
    // THE anchor not landed at slot 7: blocked `AnchorRequired`, next slot.
    let mut without_anchor = fx.reads().accounts;
    without_anchor.insert(anchor_addr(), None);
    let port_a = FakePort::new(without_anchor, clock);
    let port_b = FakePort::new(fx.reads().accounts, clock);
    let mut review = WideReview::new(deployment);
    assert!(review.proofs.supply(fx.proof.clone()));
    assert_eq!(step(&mut review, &port_a, &mut cache, 7), 1);
    let r = &review.status()["recent"][0];
    assert_eq!(r["outcome"], "blocked");
    assert_eq!(r["block"], "AnchorRequired(\"absent\")");
    assert_eq!(r["next"], "next slot");
    assert_eq!(
        r["publication_served"], true,
        "the gate passed; the anchor is what is missing"
    );
    // The same slot again: nothing. The anchor landed by slot 8: planned
    // again at once and a candidate — one retry, not a 64-slot wait.
    assert_eq!(step(&mut review, &port_a, &mut cache, 7), 0);
    assert_eq!(step(&mut review, &port_b, &mut cache, 8), 1);
    assert_eq!((review.reveal_candidates, review.transient_retries), (1, 1));
    let r = &review.status()["recent"][0];
    assert_eq!(r["outcome"], "candidate");
    assert_eq!(r["retry"], 1);
    assert_eq!(r["candidate"]["crypto"], "IbeOpened");
    assert_eq!(r["assessment"]["review"]["admitted"], false);
    assert_eq!(engine.pending_len(), 0);
    // A candidate waits the reveal refresh, not the next slot.
    assert_eq!(step(&mut review, &port_b, &mut cache, 9), 0);
    // A closed window (the observed clock at the close) is not retried at
    // the next slot; it is planned again only after the full refresh, and
    // is still closed then.
    let port_c = FakePort::new(fx.reads().accounts, clock_at(a_ts() + REVEAL_WINDOW as i64));
    let mut review2 = WideReview::new(deployment);
    assert!(review2.proofs.supply(fx.proof.clone()));
    assert_eq!(step(&mut review2, &port_c, &mut cache, 7), 1);
    let r = &review2.status()["recent"][0];
    assert_eq!(r["outcome"], "blocked");
    assert!(r["block"].as_str().unwrap().starts_with("WindowClosed"));
    assert!(r["next"].is_null(), "no next-slot retry");
    assert_eq!(step(&mut review2, &port_c, &mut cache, 8), 0);
    assert_eq!(
        step(&mut review2, &port_c, &mut cache, 7 + REFRESH_SLOTS - 1),
        0
    );
    assert_eq!(
        step(&mut review2, &port_c, &mut cache, 7 + REFRESH_SLOTS),
        1
    );
    assert_eq!(review2.transient_retries, 0);
    assert_eq!(review2.reveal_candidates, 0);
    // This host already holding a slot at the destination: `AlreadyRevealed`,
    // not retried at the next slot either.
    let mut fx_d = Fx::with_material(pt, ARRIVE_BELL, salt, seal);
    fx_d.slots[0] = Some(slot_bytes(0, host(), citizen(), TROOPS));
    let port_d = FakePort::new(fx_d.reads().accounts, clock);
    let mut review3 = WideReview::new(deployment);
    assert!(review3.proofs.supply(fx.proof.clone()));
    assert_eq!(step(&mut review3, &port_d, &mut cache, 7), 1);
    assert_eq!(review3.status()["recent"][0]["block"], "AlreadyRevealed");
    assert_eq!(step(&mut review3, &port_d, &mut cache, 8), 0);
    assert_eq!(review3.transient_retries, 0);
    // Every port refused simulate/send; nothing pending anywhere.
    for p in [&port_a, &port_b, &port_c, &port_d] {
        assert_eq!(p.forbidden.load(Ordering::SeqCst), 0);
    }
    assert_eq!(engine.pending_len(), 0);
    // The beacon was fetched once for all of it.
    assert_eq!(drand.asks.load(Ordering::SeqCst), 1);
}
