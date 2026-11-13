#![cfg(feature = "expedition-dispatch-experimental")]
//! The conquest prepare CLI: its closed request, its Free City site reading, and the whole preparation over ONE
//! union snapshot (the inspection's own keys, the roster among them, and the conquest step's). Pure bytes and JSON:
//! no key, signature, process, RPC or filesystem write.
#![allow(dead_code, unused_imports)]
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use fclient::ports::{Account, ClockSysvar};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::{header, player::holding_ref as HR, province::entry as E};
use frontier_abi::v2::layout::{
    player::{citizen as C, holding as H},
    province::{province as P, site as SM},
    world::season as S,
};
use frontier_abi::world_index::{
    expedition::AccountResolver, expedition_bridge::BridgeMarker,
    expedition_transport::OwnedBridgeTransit, land, march, roster::wide_roster, tiles::TileAddress,
    wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT, ProvinceKey, WideCoord, WideProvince, WideRoster,
    WideTransit,
};
use keeper_core::wideduty::{Deployment, Reads, Scope};
use keeper_core::wideexpedition::{ReadPlan, Selection};
use keeper_core::wideexpedition_preview::{self as preview, parse_request, preview_bytes, Report};
use keeper_core::widesnapshot::{
    parse_snapshot_response, sysvar_owner, Snapshot, SnapshotError, SnapshotSource,
};
use serde_json::{json, Value};
use solana_address::Address;

const ID: u64 = 11;
const GENESIS: i64 = 1_700_000_000;
const VERSION: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1 | WIDE_EXPERIMENTAL_VERSION_BIT;

fn a(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn header_bytes(size: usize, magic: [u8; 8]) -> Vec<u8> {
    let mut data = vec![0; size];
    assert!(wr_arr(&mut data, header::MAGIC, &magic));
    assert!(wr_u64(&mut data, header::SEASON_ID, ID));
    assert!(wr_u16(&mut data, header::LAYOUT_VERSION, 2));
    data
}

struct Fixture {
    scope: Scope,
    selected: Selection,
    keys: ReadPlan,
    reads: Reads,
    entry: Entry,
}
impl Fixture {
    fn new() -> Self {
        let program = a(4);
        let (season, bump) = fclient::addr::season_pda(&program, ID);
        let scope = Scope {
            program,
            season,
            deployment: Some(Deployment {
                program_version: VERSION,
                ruleset_hash: [9; 32],
            }),
        };
        let ctx = AddrCtx {
            program: program.to_bytes(),
            season: season.to_bytes(),
        };
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        let host = resolver
            .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap();
        let standing = ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(129, 0).unwrap(),
        );
        let selected = Selection {
            host,
            standing,
            original_owner: Address::new_from_array(ctx.citizen(&a(7).to_bytes())),
        };
        let keys = ReadPlan::new(&scope, selected).unwrap();
        let mut s = header_bytes(S::SIZE, S::MAGIC);
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BUMP] = bump;
        assert!(wr_u16(&mut s, S::PROGRAM_VERSION, VERSION));
        assert!(wr_arr(&mut s, S::RULESET_HASH, &[9; 32]));
        assert!(wr_arr(&mut s, S::GENESIS_TS, &GENESIS.to_le_bytes()));
        assert!(wr_u32(&mut s, S::BELL_SECS, 600));
        assert!(wr_u32(&mut s, S::END_BELL, 1008));
        let mut h = header_bytes(H::SIZE, H::MAGIC);
        assert!(wr_i16(&mut h, H::P, 128));
        h[H::SITE] = host.site();
        h[H::GEN] = host.gen();
        h[H::STATE] = H::STATE_FINAL;
        h[H::ORDER] = 1;
        assert!(wr_arr(
            &mut h,
            H::OWNER_CITIZEN,
            &selected.original_owner.to_bytes()
        ));
        assert!(wr_u32(&mut h, H::HOST_SEQ, 1));
        assert!(wr_u32(&mut h, H::reserve(2), 12));
        let mut home = header_bytes(P::SIZE, P::MAGIC);
        assert!(wr_i16(&mut home, P::P, 128));
        assert!(wr_u32(&mut home, P::RESOLVED_NEXT, 10));
        let mut citizen = header_bytes(C::SIZE, C::MAGIC);
        assert!(wr_arr(&mut citizen, C::WALLET, &a(7).to_bytes()));
        let slot = C::holding_of_slot(1);
        assert!(wr_i16(&mut citizen, slot + HR::P, 128));
        citizen[slot + HR::SITE] = host.site();
        citizen[slot + HR::GEN] = host.gen();
        let mut pd = vec![0; land::province::SIZE];
        WideProvince {
            season_id: ID,
            world: standing.world(),
            coord: standing.coord(),
            wedge: standing.coord().wedge().unwrap(),
            region: 0,
            opened_bell: 1,
            readiness: land::readiness::REQUIRED,
            seed_round: 100,
            ring_seed: [9; 32],
            funded_lamports: 50,
        }
        .write_identity(&mut pd)
        .unwrap();
        let roster = WideRoster::new(ID, standing, a(8).to_bytes());
        let mut rd = vec![0; wide_roster::SIZE];
        roster.write_header(&mut rd).unwrap();
        let id = roster.claim(&mut rd, 2, &host).unwrap();
        let entry = Entry {
            id,
            unit: 2,
            state: E::STATE_DEPARTED,
            troops: 12_345,
            pend_bell: 9,
            op: EntryOp::Leave,
            ..Entry::FREE
        };
        write_entry(&mut pd, 2, &entry).unwrap();
        pd[P::N_ENTRIES] = 1;
        assert!(wr_u32(&mut pd, P::RESOLVED_NEXT, 10));
        let mut reads = Reads::new(80);
        reads.clock = Some(ClockSysvar {
            slot: 100,
            unix_timestamp: GENESIS + 6_000,
            ..ClockSysvar::default()
        });
        for key in keys.keys() {
            reads.accounts.insert(*key, None);
        }
        for (key, data) in [
            (season, s),
            (keys.holding(), h),
            (keys.home(), home),
            (selected.original_owner, citizen),
            (keys.standing(), pd),
            (keys.roster(), rd),
        ] {
            reads.accounts.insert(
                key,
                Some(Account {
                    lamports: 10_000_000,
                    data,
                    owner: program,
                    executable: false,
                }),
            );
        }
        Self {
            scope,
            selected,
            keys,
            reads,
            entry,
        }
    }
    fn data(&mut self, key: Address) -> &mut Vec<u8> {
        &mut self
            .reads
            .accounts
            .get_mut(&key)
            .unwrap()
            .as_mut()
            .unwrap()
            .data
    }
    fn entry(&mut self, state: u8, op: EntryOp) {
        self.entry.state = state;
        self.entry.op = op;
        let entry = self.entry;
        write_entry(self.data(self.keys.standing()), 2, &entry).unwrap();
    }
    fn bridge(&mut self) -> OwnedBridgeTransit {
        let ctx = AddrCtx {
            program: self.scope.program.to_bytes(),
            season: self.scope.season.to_bytes(),
        };
        let t = WideTransit::depart(
            march::HOST_IDENTITY_FULL_REF_V1,
            self.selected.host,
            2,
            0,
            TileAddress::new(self.selected.host.key(), 0).unwrap(),
            9,
            11,
            GENESIS + 5_400,
            12_345,
            10_000,
            10_000,
            [5; 32],
            0,
            0,
            a(8).to_bytes(),
        )
        .unwrap();
        let bridge =
            OwnedBridgeTransit::new(&ctx, 0, t, self.selected.original_owner.to_bytes()).unwrap();
        let marker = BridgeMarker::new(&ctx, bridge.common(), 0, 0).unwrap();
        self.data(self.keys.holding())[H::transit(0)..H::transit(0) + 96]
            .copy_from_slice(&marker.to_bytes());
        self.reads.accounts.insert(
            self.keys.bridges()[0],
            Some(Account {
                lamports: 100,
                data: bridge.to_bytes().to_vec(),
                owner: self.scope.program,
                executable: false,
            }),
        );
        bridge
    }
}

fn encoded(a: &Account) -> Value {
    json!({"owner": a.owner.to_string(), "data": [base64::engine::general_purpose::STANDARD.encode(&a.data), "base64"], "lamports": a.lamports, "executable": a.executable})
}
fn snapshot(f: &Fixture) -> Snapshot {
    let mut values: Vec<_> = f
        .keys
        .keys()
        .iter()
        .map(|key| f.reads.accounts[key].as_ref().map_or(Value::Null, encoded))
        .collect();
    values.push(encoded(&Account {
        data: f.reads.clock.unwrap().encode().to_vec(),
        owner: sysvar_owner(),
        lamports: 1,
        executable: false,
    }));
    parse_snapshot_response(
        &json!({"context": {"slot": 100}, "value": values}),
        f.keys.keys(),
        false,
        80,
    )
    .unwrap()
}

impl Fixture {
    fn request(&self) -> Value {
        let pin = self.scope.deployment.unwrap();
        json!({"schema":preview::REQUEST_SCHEMA,"operation":"inspect","cluster":"localnet","program":self.scope.program.to_string(),"season":self.scope.season.to_string(),"deployment":{"program_version":pin.program_version.to_string(),"ruleset_hash":hex::encode(pin.ruleset_hash)},"host":hex::encode(self.selected.host.to_bytes()),"original_owner":self.selected.original_owner.to_string(),"standing":{"p":self.selected.standing.coord().p().to_string(),"q":self.selected.standing.coord().q().to_string()},"min_slot":"80","wallet":a(7).to_string(),"payer":a(7).to_string()})
    }
    fn source(&self) -> Source {
        Source {
            result: Ok(snapshot(self)),
            keys: self.keys.keys().to_vec(),
            calls: AtomicUsize::new(0),
        }
    }
}
struct Source {
    result: Result<Snapshot, SnapshotError>,
    keys: Vec<Address>,
    calls: AtomicUsize,
}
impl SnapshotSource for Source {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(keys, self.keys);
        assert!(!rent);
        assert!(min_slot <= 100);
        Box::pin(async move { self.result.clone() })
    }
    fn label(&self) -> &'static str {
        "secret://do-not-print/private"
    }
}
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::province::site as SMV1;
use keeper_core::experimental_conquest_prepare::{
    failure, free_city_tile, output_bytes, parse_request as conquest_parse, REPORT_SCHEMA, REQUEST_SCHEMA,
};
use permutation_rules::frontier::clash::NEUTRAL;

const SOURCE: &str = include_str!("fixtures/original_expedition_preview_dissolve_request.json");

fn request() -> Value {
    let mut source: Value = serde_json::from_str(SOURCE).unwrap();
    source["deployment"]["program_version"] = json!("18436");
    json!({"schema": REQUEST_SCHEMA, "request_id": "cq_1", "action": "DeclareSiege", "source_request": source,
        "source_context_slot": "80", "source_snapshot_digest": "ab".repeat(32), "target": {"site": 3, "entry": 0}})
}
fn parses(v: &Value) -> bool {
    conquest_parse(&serde_json::to_vec(v).unwrap()).is_ok()
}

#[test]
fn the_request_is_closed() {
    let good = request();
    assert!(parses(&good));
    let changes: Vec<Box<dyn Fn(&mut Value)>> = vec![
        Box::new(|v| v["action"] = json!("SettleCapture")),
        Box::new(|v| v["action"] = json!("Dissolve")),
        Box::new(|v| v["schema"] = json!("frontier-experimental-expedition-prepare-request-v1")),
        Box::new(|v| v["target"]["site"] = json!(12)),
        Box::new(|v| v["target"]["entry"] = json!(56)),
        Box::new(|v| v["target"]["site"] = json!(-1)),
        Box::new(|v| v["target"]["site"] = json!("3")),
        Box::new(|v| v["target"]["tile"] = json!(3)),
        Box::new(|v| v["instruction_hex"] = json!("daff")),
        Box::new(|v| v["request_id"] = json!("")),
        Box::new(|v| v["source_context_slot"] = json!("79")),
        Box::new(|v| v["source_snapshot_digest"] = json!("AB".repeat(32))),
        Box::new(|v| v["source_request"]["deployment"]["program_version"] = json!("16388")),
        // the player acts AND pays: another payer, or none, is not this request
        Box::new(|v| v["source_request"]["payer"] = Value::Null),
        Box::new(|v| v["source_request"]["wallet"] = Value::Null),
        Box::new(|v| {
            v["source_request"]["payer"] = json!("B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3")
        }),
    ];
    for (i, change) in changes.iter().enumerate() {
        let mut v = good.clone();
        change(&mut v);
        assert!(!parses(&v), "change {i}");
    }
    assert!(conquest_parse(&vec![b' '; 16 * 1024 + 1]).is_err());
}

#[test]
fn a_blocked_report_is_closed_and_bounded() {
    let r = conquest_parse(&serde_json::to_vec(&request()).unwrap()).unwrap();
    let v = failure(Some(&r), "DispatchKindUnavailable");
    assert_eq!(v["schema"], REPORT_SCHEMA);
    assert_eq!(v["status"], "blocked");
    assert_eq!(v["blocker"]["code"], "DispatchKindUnavailable");
    assert_eq!(v["request"], *r.echo());
    for k in ["ready", "deployment_verified", "admitted", "signed", "enqueued", "relay_submission_available", "automatic_send"] {
        assert_eq!(v[k], false, "{k}");
    }
    assert_eq!(v["host_only"], true);
    assert!(v["prepared"].is_null() && v["blockhash"].is_null() && v["source"].is_null());
    assert!(output_bytes(&v).len() <= 32 * 1024);
}

fn province(sites: &[(u8, u8, u8, u8, u8)]) -> Vec<u8> {
    // (tile, state, gen, order, faction) per site
    let mut d = vec![0u8; 4864];
    d[PV::SITE_COUNT] = sites.len() as u8;
    for (i, (tile, state, gen, order, faction)) in sites.iter().enumerate() {
        d[PV::SITES + i] = *tile;
        let o = PV::site(i);
        d[o + SM::STATE] = *state;
        d[o + SM::GEN] = *gen;
        d[o + SM::ORDER] = *order;
        d[o + SM::FACTION] = *faction;
    }
    d
}

#[test]
fn a_site_is_a_free_city_only_exactly_as_the_handler_requires() {
    let city = (43, SM::STATE_FREE_CITY, 0, 0, NEUTRAL);
    let d = province(&[(10, SMV1::STATE_HOLDING, 1, 1, 2), city, (20, SMV1::STATE_FREE, 0, 0, 0)]);
    assert_eq!(free_city_tile(&d, 1), Ok(43));
    // a village, free land, a site past the count
    assert_eq!(free_city_tile(&d, 0), Err("TargetNotFreeCity"));
    assert_eq!(free_city_tile(&d, 2), Err("TargetNotFreeCity"));
    assert_eq!(free_city_tile(&d, 3), Err("TargetNotFreeCity"));
    assert_eq!(free_city_tile(&d, 11), Err("TargetNotFreeCity"));
    // a Free City state with a generation, an order or a nation is not the initial Free City
    for bad in [
        (43, SM::STATE_FREE_CITY, 1, 0, NEUTRAL),
        (43, SM::STATE_FREE_CITY, 0, 1, NEUTRAL),
        (43, SM::STATE_FREE_CITY, 0, 0, 2),
        (43, SMV1::STATE_HOLDING, 0, 0, NEUTRAL),
    ] {
        assert_eq!(free_city_tile(&province(&[bad]), 0), Err("TargetNotFreeCity"));
    }
    // a count beyond the array is not read as sites
    let mut over = province(&[city]);
    over[PV::SITE_COUNT] = PV::SITES_N as u8 + 1;
    assert_eq!(free_city_tile(&over, 0), Err("TargetNotFreeCity"));
    // bytes too short to hold the mirror
    assert_eq!(free_city_tile(&d[..PV::SITE_COUNT], 1), Err("SourceUnavailable"));
}

// ------------------------------------------------------------------ the whole preparation over ONE union snapshot
// The Fixture above is the audited preview test's constructor (tests/wide_expedition_preview.rs, lines 6-240, taken
// as they are): literal public identities and storage bytes of an original host observed in the wide province.
use keeper_core::experimental_conquest_prepare::{prepare, Settings};
use std::sync::Mutex;

const DISPATCH: u16 = frontier_abi::world_index::expedition_dispatch_ix::PROGRAM_VERSION;

/// A source that answers ANY key set from the fixture's accounts (a key it does not hold is absent) at `slot`, and
/// records what was asked.
struct Union {
    accounts: std::collections::BTreeMap<Address, Option<Account>>,
    clock: ClockSysvar,
    slot: u64,
    asked: Mutex<Vec<(Vec<Address>, bool, u64)>>,
}
impl SnapshotSource for Union {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        self.asked.lock().unwrap().push((keys.to_vec(), rent, min_slot));
        let mut values: Vec<_> = keys
            .iter()
            .map(|k| self.accounts.get(k).and_then(|a| a.as_ref()).map_or(Value::Null, encoded))
            .collect();
        values.push(encoded(&Account { data: self.clock.encode().to_vec(), owner: sysvar_owner(), lamports: 1, executable: false }));
        let result = parse_snapshot_response(&json!({"context": {"slot": self.slot}, "value": values}), keys, rent, min_slot);
        Box::pin(async move { result })
    }
}
/// The fixture as a host that simply STAYS at roster entry 2 of (129, 0), on the tile of a Free City at site 1,
/// under the dispatch revision the conquest request requires.
fn staying() -> Fixture {
    let mut f = Fixture::new();
    f.scope.deployment = Some(Deployment { program_version: DISPATCH, ruleset_hash: [9; 32] });
    let season = f.scope.season;
    assert!(wr_u16(f.data(season), S::PROGRAM_VERSION, DISPATCH));
    f.entry(E::STATE_ROSTER, EntryOp::None);
    let (tile, standing) = (f.entry.tile, f.keys.standing());
    let pd = f.data(standing);
    pd[P::SITE_COUNT] = 2;
    pd[P::SITES] = tile.wrapping_add(1) % 61;
    pd[P::SITES + 1] = tile;
    let o = P::site(1);
    pd[o + SM::STATE] = SM::STATE_FREE_CITY;
    pd[o + SM::GEN] = 0;
    pd[o + SM::ORDER] = 0;
    pd[o + SM::FACTION] = NEUTRAL;
    f
}
fn conquest_request(f: &Fixture, site: u8, entry: u8, floor: &str) -> Value {
    json!({"schema": REQUEST_SCHEMA, "request_id": "cq_1", "action": "DeclareSiege", "source_request": f.request(),
        "source_context_slot": floor, "source_snapshot_digest": "ab".repeat(32), "target": {"site": site, "entry": entry}})
}
fn union(f: &Fixture, slot: u64) -> Union {
    // (the Clock of a response is of that response's slot)
    let clock = ClockSysvar { slot, ..f.reads.clock.unwrap() };
    Union { accounts: f.reads.accounts.clone(), clock, slot, asked: Mutex::new(Vec::new()) }
}
fn settings(f: &Fixture) -> Settings {
    Settings { program: f.scope.program, season: f.scope.season, fee_payer: a(7), ruleset_hash: [9; 32], cu_limit: 400_000, loaded_limit: 1_048_576 }
}
/// Run the preparation; the blockhash provider must never be reached unless the dispatch feature wraps.
fn blocker(f: &Fixture, v: &Value, s: &Union) -> String {
    let r = conquest_parse(&serde_json::to_vec(v).unwrap()).unwrap();
    let out = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(prepare(&r, settings(f), s, |_| async { Err(()) }));
    assert_eq!(out["status"], "blocked", "{out}");
    for k in ["signed", "ready", "admitted", "enqueued", "automatic_send"] {
        assert_eq!(out[k], false);
    }
    out["blocker"]["code"].as_str().unwrap().to_owned()
}
/// What a preparation that passed EVERY read check answers in this build: without the conquest dispatch feature the
/// closed kind blocker; with it, the (injected, failing) blockhash read is the first thing after the checks.
const PASSED: &str = if cfg!(feature = "conquest-dispatch-experimental") { "BlockhashUnavailable" } else { "DispatchKindUnavailable" };

#[test]
fn one_union_snapshot_carries_every_check_and_its_slot_is_the_reports() {
    let f = staying();
    let s = union(&f, 100);
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &s), PASSED);
    let asked = s.asked.lock().unwrap();
    assert_eq!(asked.len(), 1, "ONE read: nothing is taken from an earlier or a second one");
    let (keys, rent, min_slot) = &asked[0];
    assert!(!rent);
    assert_eq!(*min_slot, 80);
    // the inspection's own keys (the province AND its roster among them) and the conquest step's three
    for k in f.keys.keys() {
        assert!(keys.contains(k));
    }
    assert!(keys.contains(&f.keys.roster()) && keys.contains(&f.keys.standing()));
    assert_eq!(keys.len(), f.keys.keys().len() + 3);
    assert_eq!(keys.iter().collect::<std::collections::BTreeSet<_>>().len(), keys.len());
}

#[test]
fn the_roster_entry_must_be_the_selected_host_in_the_same_snapshot() {
    // the same entry index, the same state and tile in the Province, but the roster now pairs it with ANOTHER host of
    // the same village (the next sequence): an entry reused after the selected host left
    let mut f = staying();
    let ctx = AddrCtx { program: f.scope.program.to_bytes(), season: f.scope.season.to_bytes() };
    let other = AccountResolver::for_season(&ctx).unwrap().legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 1).unwrap()).unwrap();
    assert_ne!(other.to_bytes(), f.selected.host.to_bytes());
    let roster = WideRoster::new(ID, f.selected.standing, a(8).to_bytes());
    let mut rd = vec![0; wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    roster.claim(&mut rd, 2, &other).unwrap();
    let (at, village) = (f.keys.roster(), f.keys.holding());
    *f.data(at) = rd;
    assert!(wr_u32(f.data(village), H::HOST_SEQ, 2));
    let code = blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 101));
    assert_ne!(code, PASSED);
    assert!(["SourceBlocked", "SiegeUnavailable", "HostNotOnTarget"].contains(&code.as_str()), "{code}");
    // an empty roster entry (the host is gone, nobody took it) is refused the same way
    let mut f = staying();
    let roster = WideRoster::new(ID, f.selected.standing, a(8).to_bytes());
    let mut rd = vec![0; wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    let at = f.keys.roster();
    *f.data(at) = rd;
    assert_ne!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 101)), PASSED);
}

#[test]
fn a_host_that_is_leaving_spent_or_in_transit_is_not_offered_a_siege() {
    // a pending Leave (the turn has not processed it yet)
    let mut f = staying();
    f.entry(E::STATE_ROSTER, EntryOp::Leave);
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 100)), "SiegeUnavailable");
    // departed with its Leave processed (the return stage)
    let mut f = staying();
    f.entry(E::STATE_DEPARTED, EntryOp::Leave);
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 100)), "SiegeUnavailable");
    // a pending Spend
    let mut f = staying();
    f.entry(E::STATE_ROSTER, EntryOp::Spend { cost: 1 });
    assert_ne!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 100)), PASSED);
    // a bridge in flight
    let mut f = staying();
    f.bridge();
    assert_ne!(blocker(&f, &conquest_request(&f, 1, 2, "80"), &union(&f, 100)), PASSED);
}

#[test]
fn the_context_only_moves_forward_and_the_floor_is_the_requests() {
    let f = staying();
    // the snapshot is older than the observation the request was made on
    // (refused by the snapshot reader itself: a response below the asked floor is no snapshot)
    let old = blocker(&f, &conquest_request(&f, 1, 2, "101"), &union(&f, 100));
    assert!(["SourceBlocked", "SourceUnavailable"].contains(&old.as_str()), "{old}");
    let s = union(&f, 100);
    blocker(&f, &conquest_request(&f, 1, 2, "100"), &s);
    assert_eq!(s.asked.lock().unwrap()[0].2, 100, "the read is asked for at no older a slot than the request's observation");
    // newer is fine, and every check is then made at the newer slot
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 2, "100"), &union(&f, 100)), PASSED);
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 2, "90"), &union(&f, 250)), PASSED);
}

#[test]
fn the_target_is_this_free_city_under_this_entry_with_an_absent_holding_position() {
    let f = staying();
    // another site of the province is not a Free City; a site past the count; another entry than the host's
    assert_eq!(blocker(&f, &conquest_request(&f, 0, 2, "80"), &union(&f, 100)), "TargetNotFreeCity");
    assert_eq!(blocker(&f, &conquest_request(&f, 5, 2, "80"), &union(&f, 100)), "TargetNotFreeCity");
    assert_eq!(blocker(&f, &conquest_request(&f, 1, 3, "80"), &union(&f, 100)), "HostNotOnTarget");
    // the Free City is on another tile than the host stands on
    let mut g = staying();
    let (tile, standing) = (g.entry.tile, g.keys.standing());
    g.data(standing)[P::SITES + 1] = tile.wrapping_add(2) % 61;
    assert_eq!(blocker(&g, &conquest_request(&g, 1, 2, "80"), &union(&g, 100)), "HostNotOnTarget");
    // the site already has a generation (not the initial Free City)
    let mut g = staying();
    let standing = g.keys.standing();
    g.data(standing)[P::site(1) + SM::GEN] = 1;
    assert_eq!(blocker(&g, &conquest_request(&g, 1, 2, "80"), &union(&g, 100)), "TargetNotFreeCity");
    // the canonical holding position already holds an account
    let g = staying();
    let ctx = AddrCtx { program: g.scope.program.to_bytes(), season: g.scope.season.to_bytes() };
    let position = Address::new_from_array(frontier_abi::world_index::holding::holding_address(&ctx, g.selected.standing.coord(), 1));
    let mut s = union(&g, 100);
    s.accounts.insert(position, Some(Account { lamports: 1, data: vec![1; 8], owner: g.scope.program, executable: false }));
    assert_eq!(blocker(&g, &conquest_request(&g, 1, 2, "80"), &s), "SiegeUnavailable");
    // another wallet than the relay's pinned payer
    let g = staying();
    let r = conquest_parse(&serde_json::to_vec(&conquest_request(&g, 1, 2, "80")).unwrap()).unwrap();
    let other = Settings { fee_payer: a(8), ..settings(&g) };
    let out = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(prepare(&r, other, &union(&g, 100), |_| async { Err(()) }));
    assert_eq!(out["blocker"]["code"], "RequestInvalid");
}

/// With the conquest dispatch feature: the WHOLE prepared report, as the CLI would print it, from the fixture's one
/// union snapshot and a fixed public blockhash observation. It is printed (so a first run can record it) and must
/// equal the recorded fixture, which the gateway's and the page's validators are then run on
/// (permutation-gateway/test/web-frontier-conquest-rust-report.test.mjs). No key, no signature, no RPC.
#[cfg(feature = "conquest-dispatch-experimental")]
#[test]
fn the_whole_prepared_report_is_the_recorded_one() {
    use fclient::blockhash_preflight::ObservedBlockhash;
    use fclient::unsigned_message_preflight::BlockhashObservation;
    const RECORDED: &str = include_str!("fixtures/conquest_declare_siege_report_v1.json");
    let f = staying();
    let s = union(&f, 100);
    let r = conquest_parse(&serde_json::to_vec(&conquest_request(&f, 1, 2, "80")).unwrap()).unwrap();
    let observed = |floor: u64| async move {
        assert_eq!(floor, 100, "the blockhash is asked for at the snapshot's own slot");
        Ok(ObservedBlockhash {
            observation: BlockhashObservation { blockhash: [24; 32], context_slot: 101, valid: true, block_height: 200, last_valid_block_height: 210 },
            latest_context_slot: 100,
            height_min_context_slot: 101,
        })
    };
    let out = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(prepare(&r, settings(&f), &s, observed));
    assert_eq!(out["status"], "prepared", "{out}");
    assert_eq!(s.asked.lock().unwrap().len(), 1, "one snapshot");
    let p = &out["prepared"];
    assert_eq!(p["dispatch"], json!({"tag": 0xDA, "kind": 12}));
    assert_eq!(p["budget"]["heap"], 256 * 1024);
    assert_eq!(p["action"], "DeclareSiege");
    assert_eq!(p["signers"], json!([a(7).to_string()]));
    assert_eq!(p["roles"].as_array().unwrap().len(), 12);
    assert_eq!(p["instruction_hex"], "daff020cdaff01050102");
    assert_eq!(out["source"]["context_slot"], "100");
    for k in ["ready", "deployment_verified", "admitted", "signed", "enqueued", "relay_submission_available", "automatic_send"] {
        assert_eq!(out[k], false, "{k}");
    }
    println!("CONQUEST_REPORT_BEGIN{}CONQUEST_REPORT_END", out);
    let recorded: Value = serde_json::from_str(RECORDED).unwrap();
    assert_eq!(recorded, out, "record the printed report into the fixture");
}
