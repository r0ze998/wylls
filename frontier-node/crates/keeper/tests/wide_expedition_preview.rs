//! Preview integration fixtures copied from the audited wide_expedition test constructor.
//! Literal PUBLIC identities and storage bytes only:
//! no key generation, crypto fixtures, signer, startup, RPC, transaction or SVM.
#![cfg(feature = "wide-world-experimental")]

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
fn run(v: &Value, s: &Source) -> Report {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(preview_bytes(&serde_json::to_vec(v).unwrap(), s))
}
fn safe(r: &Report) {
    let j = r.json();
    for field in [
        "dispatch_available",
        "admitted",
        "signed",
        "enqueued",
        "automatic_send",
        "completion_proven",
        "history_verified",
    ] {
        assert_eq!(j[field], false, "{field}");
    }
    assert_eq!(j["source"]["authority_verified"], false);
    assert_eq!(j["source"]["freshness"], "unknown");
    let s = String::from_utf8(r.to_json_bytes()).unwrap();
    assert!(!s.contains("do-not-print"));
    assert!(!s.contains("secret://"));
    assert!(s.len() <= preview::MAX_OUTPUT_BYTES);
    assert!(j.get("transaction").is_none());
    assert!(j.get("instruction").is_none());
}
#[test]
fn coherent_return_uses_one_snapshot_and_role_only_closed_draft() {
    let f = Fixture::new();
    let source = f.source();
    let req = f.request();
    let r = run(&req, &source);
    safe(&r);
    assert!(r.is_preview(), "{}", r.json());
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(r.json()["scope"], req);
    assert_eq!(
        r.json()["request_digest"],
        parse_request(&serde_json::to_vec(&req).unwrap())
            .unwrap()
            .digest()
    );
    assert_eq!(r.json()["source"]["coherent"], true);
    assert_eq!(r.json()["source"]["context_slot"], "100");
    assert_eq!(
        r.json()["facts"]["next_prerequisite"],
        "ReturnOriginalReserve"
    );
    assert_eq!(r.json()["facts"]["observed"]["return_units"], "12");
    assert_eq!(r.json()["draft"]["action"], "Return");
    assert_eq!(r.json()["draft"]["roles"].as_array().unwrap().len(), 6);
    assert_eq!(
        r.json()["draft"]["roles"][4]["address"],
        f.keys.holding().to_string()
    );
    assert!(r.json()["draft"].get("bytes").is_none());
}
#[test]
fn wallet_dissolve_checks_citizen_and_alias_effective_roles() {
    let mut f = Fixture::new();
    f.entry(E::STATE_ROSTER, EntryOp::None);
    let source = f.source();
    let req = f.request();
    let r = run(&req, &source);
    safe(&r);
    assert!(r.is_preview(), "{}", r.json());
    assert_eq!(r.json()["draft"]["action"], "Dissolve");
    let roles = r.json()["draft"]["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 8);
    assert_eq!(roles[0]["address"], roles[1]["address"]);
    assert_eq!(roles[0]["writable"], true);
    let mut wrong = req;
    wrong["wallet"] = json!(a(89).to_string());
    let r = run(&wrong, &source);
    assert!(r.is_preview());
    assert!(r.json()["draft"].is_null());
    assert_eq!(r.json()["draft_blocker"], "WalletCitizenMismatch");
    safe(&r);
}
#[test]
fn optional_proposals_never_invent_wallet_and_return_remains_permissionless() {
    let mut f = Fixture::new();
    let mut req = f.request();
    req["wallet"] = Value::Null;
    let r = run(&req, &f.source());
    assert_eq!(r.json()["draft"]["action"], "Return");
    req["payer"] = Value::Null;
    let r = run(&req, &f.source());
    assert_eq!(r.json()["draft_blocker"], "PayerProposalRequired");
    f.entry(E::STATE_ROSTER, EntryOp::None);
    req["payer"] = json!(a(7).to_string());
    let r = run(&req, &f.source());
    assert_eq!(r.json()["draft_blocker"], "WalletProposalRequired");
    req["wallet"] = json!(a(7).to_string());
    req["payer"] = json!(f.keys.holding().to_string());
    let r = run(&req, &f.source());
    assert_eq!(r.json()["draft_blocker"], "DraftAccountContract");
    safe(&r);
}
#[test]
fn bridge_and_pending_leave_inspection_never_create_resident_drafts() {
    let mut f = Fixture::new();
    f.bridge();
    let r = run(&f.request(), &f.source());
    assert!(r.is_preview(), "{}", r.json());
    assert_eq!(r.json()["facts"]["observed"]["kind"], "owned-bridge-v2");
    assert!(r.json()["draft"].is_null());
    safe(&r);
    let mut f = Fixture::new();
    f.entry(E::STATE_ROSTER, EntryOp::Leave);
    let r = run(&f.request(), &f.source());
    assert_eq!(
        r.json()["facts"]["next_prerequisite"],
        "ResolveVoluntaryLeave"
    );
    assert_eq!(r.json()["draft_blocker"], "NoResidentDraftAtThisStage");
}
#[test]
fn absent_resident_is_history_required_and_capture_generation_locks_block() {
    let mut f = Fixture::new();
    let site = P::site(f.selected.host.site() as usize);
    f.data(f.keys.home())[site + SM::STATE] = SM::STATE_HOLDING;
    f.data(f.keys.home())[site + SM::GEN] = f.selected.host.gen() + 1;
    let r = run(&f.request(), &f.source());
    assert_eq!(r.json()["blocker"]["code"], "CapturePending");
    safe(&r);
    for offset in [E::OP_A, E::OP_B, E::OP_TROOPS, E::OP_REF] {
        let mut f = Fixture::new();
        f.data(f.keys.standing())[P::entry(2) + offset] = 1;
        let r = run(&f.request(), &f.source());
        assert_eq!(r.json()["blocker"]["code"], "LeavePayloadUnsupported");
        safe(&r);
    }
    let mut f = Fixture::new();
    f.reads.accounts.insert(f.keys.roster(), None);
    let r = run(&f.request(), &f.source());
    assert_eq!(
        r.json()["blocker"]["code"],
        "ResidentMissingHistoryRequired"
    );
    safe(&r);
    let mut f = Fixture::new();
    f.data(f.keys.holding())[H::GEN] += 1;
    let r = run(&f.request(), &f.source());
    assert_eq!(r.json()["blocker"]["code"], "SourceGeneration");
    let mut f = Fixture::new();
    f.data(f.keys.holding())[H::STATE] = H::STATE_RELEASED;
    let r = run(&f.request(), &f.source());
    assert!(!r.is_preview());
    safe(&r);
}
#[test]
fn invalid_inputs_fail_before_read_and_do_not_echo_payloads() {
    let f = Fixture::new();
    let source = f.source();
    let req = f.request();
    let changes = [
        ("schema", json!("wrong")),
        ("operation", json!("Depart")),
        ("cluster", json!("http://secret.invalid")),
        ("min_slot", json!(80)),
        ("min_slot", json!("080")),
        ("min_slot", json!("-1")),
        ("host", json!("ff")),
        ("program", json!(Address::default().to_string())),
        ("wallet", json!("private invalid")),
    ];
    for (field, value) in changes {
        let mut v = req.clone();
        v[field] = value;
        let r = run(&v, &source);
        assert!(!r.is_preview());
        assert!(r.json()["scope"].is_null());
        safe(&r);
    }
    for field in ["program", "season", "host", "wallet", "payer"] {
        let mut v = req.clone();
        v.as_object_mut().unwrap().remove(field);
        assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
    }
    for value in [
        json!("-0"),
        json!("+129"),
        json!("0129"),
        json!("9223372036854775808"),
        json!(129),
    ] {
        let mut v = req.clone();
        v["standing"]["p"] = value;
        assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
    }
    let mut v = req.clone();
    v["standing"]["p"] = json!("128");
    assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
    let mut v = req.clone();
    v["deployment"]["program_version"] = json!("1");
    assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
    let mut v = req;
    v["rpc_url"] = json!("http://secret.invalid");
    assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn request_digest_binds_every_scope_value_and_ignores_json_spacing() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let v = f.request();
    let a = parse_request(&serde_json::to_vec(&v).unwrap()).unwrap();
    let b = parse_request(&serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    assert_eq!(a.digest(), b.digest());
    let fields = [
        "inspect",
        "localnet",
        v["program"].as_str().unwrap(),
        v["season"].as_str().unwrap(),
        v["deployment"]["program_version"].as_str().unwrap(),
        v["deployment"]["ruleset_hash"].as_str().unwrap(),
        v["host"].as_str().unwrap(),
        v["original_owner"].as_str().unwrap(),
        "129",
        "0",
        "80",
        v["wallet"].as_str().unwrap(),
        v["payer"].as_str().unwrap(),
    ];
    assert_eq!(
        a.digest(),
        hex::encode(Sha256::digest(
            format!("{}\n{}\n", preview::REQUEST_SCHEMA, fields.join("\n")).as_bytes()
        ))
    );
    for (field, value) in [
        ("cluster", json!("devnet")),
        ("min_slot", json!("0")),
        ("wallet", Value::Null),
        ("payer", Value::Null),
    ] {
        let mut c = v.clone();
        c[field] = value;
        assert_ne!(
            a.digest(),
            parse_request(&serde_json::to_vec(&c).unwrap())
                .unwrap()
                .digest()
        );
    }
    let mut c = v;
    c["standing"]["p"] = json!("9007199254740993");
    assert!(parse_request(&serde_json::to_vec(&c).unwrap()).is_ok());
}
#[test]
fn bounded_reader_consumes_only_limit_plus_one_and_rejects_unknown_fields() {
    use std::io::Read;
    let mut input = std::io::Cursor::new(vec![b' '; preview::MAX_REQUEST_BYTES + 10]);
    let e = preview::read_request(&mut input).unwrap_err();
    assert_eq!(e.code, "RequestTooLarge");
    assert_eq!(input.position(), (preview::MAX_REQUEST_BYTES + 1) as u64);
    let mut leftover = Vec::new();
    input.read_to_end(&mut leftover).unwrap();
    assert_eq!(leftover.len(), 9);
}
#[test]
fn snapshot_failures_are_bound_scrubbed_once_and_never_retried() {
    let f = Fixture::new();
    let req = f.request();
    for e in [
        SnapshotError::Unsupported,
        SnapshotError::Rpc("secret://do-not-print/private".into()),
        SnapshotError::Malformed("secret://do-not-print/private"),
        SnapshotError::BadClock("secret://do-not-print/private"),
    ] {
        let mut s = f.source();
        s.result = Err(e);
        let r = run(&req, &s);
        assert!(!r.is_preview());
        assert_eq!(r.json()["scope"], req);
        assert_eq!(r.json()["source"]["read_calls"], "1");
        assert_eq!(s.calls.load(Ordering::SeqCst), 1);
        safe(&r);
    }
    let r = preview::snapshot_timeout_failure(
        &parse_request(&serde_json::to_vec(&req).unwrap()).unwrap(),
    );
    assert_eq!(r.json()["scope"], req);
    assert_eq!(r.json()["blocker"]["code"], "PreviewTimeout");
    safe(&r);
}
#[test]
fn coherent_but_wrong_minimum_or_keyset_and_oversized_data_are_rejected() {
    let f = Fixture::new();
    let mut req = f.request();
    req["min_slot"] = json!("0");
    let r = run(&req, &f.source());
    assert_eq!(r.json()["blocker"]["code"], "SnapshotRequestMismatch");
    let mut f = Fixture::new();
    let original = f.keys.keys().to_vec();
    f.selected.standing = ProvinceKey::new(
        f.selected.standing.world(),
        WideCoord::checked(130, 0).unwrap(),
    );
    f.keys = ReadPlan::new(&f.scope, f.selected).unwrap();
    for key in f.keys.keys() {
        f.reads.accounts.entry(*key).or_insert(None);
    }
    let mut source = f.source();
    source.keys = original;
    let original = Fixture::new();
    let r = run(&original.request(), &source);
    assert_eq!(r.json()["blocker"]["code"], "SnapshotKeySetMismatch");
    let mut f = Fixture::new();
    f.data(f.keys.holding())
        .resize(preview::MAX_SNAPSHOT_DATA_BYTES + 1, 0);
    let r = run(&f.request(), &f.source());
    assert_eq!(r.json()["blocker"]["code"], "SnapshotDataTooLarge");
    safe(&r);
}
#[test]
fn deployment_pins_and_foreign_or_executable_accounts_block() {
    let f = Fixture::new();
    let mut req = f.request();
    req["deployment"]["program_version"] = json!((VERSION + 1).to_string());
    assert_eq!(
        run(&req, &f.source()).json()["blocker"]["code"],
        "ProgramVersion"
    );
    let mut req = f.request();
    req["deployment"]["ruleset_hash"] = json!(hex::encode([8; 32]));
    assert_eq!(
        run(&req, &f.source()).json()["blocker"]["code"],
        "RulesetHash"
    );
    let mut f = Fixture::new();
    f.reads
        .accounts
        .get_mut(&f.keys.holding())
        .unwrap()
        .as_mut()
        .unwrap()
        .executable = true;
    assert_eq!(
        run(&f.request(), &f.source()).json()["blocker"]["code"],
        "ExecutableAccount"
    );
    let mut f = Fixture::new();
    f.reads
        .accounts
        .get_mut(&f.keys.holding())
        .unwrap()
        .as_mut()
        .unwrap()
        .owner = a(99);
    assert_eq!(
        run(&f.request(), &f.source()).json()["blocker"]["code"],
        "ForeignOwner"
    );
}

// Immutable actual Rust output for cross-language gateway/UI contract parity.
// These bytes contain only the literal public fixture's request and report.
#[test]
fn public_preview_goldens_match_full_request_and_report_bytes() {
    for (dissolve, expected_request, expected_report) in [
        (
            false,
            include_bytes!("fixtures/original_expedition_preview_return_request.json").as_slice(),
            include_bytes!("fixtures/original_expedition_preview_return_report.json").as_slice(),
        ),
        (
            true,
            include_bytes!("fixtures/original_expedition_preview_dissolve_request.json").as_slice(),
            include_bytes!("fixtures/original_expedition_preview_dissolve_report.json").as_slice(),
        ),
    ] {
        let mut f = Fixture::new();
        if dissolve {
            f.entry(E::STATE_ROSTER, EntryOp::None);
        }
        let request = f.request();
        let report = run(&request, &f.source());
        assert!(report.is_preview());
        safe(&report);
        assert_eq!(serde_json::to_vec(&request).unwrap(), expected_request);
        assert_eq!(report.to_json_bytes(), expected_report);
    }
}
