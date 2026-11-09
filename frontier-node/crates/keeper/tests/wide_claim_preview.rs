//! Pure parser/orchestrator tests with literal public account identities.
//! No key generation, private derivation, signing, daemon, journal, network,
//! binary subprocess, native-crypto fixture, simulation or transaction send.
#![cfg(feature = "wide-world-experimental")]

use std::collections::BTreeMap;
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use base64::Engine as _;
use fclient::ports::{Account, ClockSysvar};
use frontier_abi::addr::{defence_claim_seed, keeper_tag8, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_u16, wr_u32, wr_u64};
use frontier_abi::layout::beacon::bell_anchor as BA;
use frontier_abi::layout::world::{defence_pool as DP, season as S};
use frontier_abi::world_index::arrival::{wide_arrival_slot as AS, WideArrivalSlot};
use frontier_abi::world_index::rules::wide_region;
use frontier_abi::world_index::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT;
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use keeper_core::wideclaim::SlotId;
use keeper_core::wideclaim_preview::{
    parse_request, preview_bytes, read_request, validate_rpc_url, Report, MAX_OUTPUT_BYTES,
    MAX_REQUEST_BYTES, MAX_SNAPSHOT_DATA_BYTES,
};
use keeper_core::wideduty::{Deployment, Scope};
use keeper_core::widesnapshot::{
    parse_snapshot_response, sysvar_owner, RentSysvar, Snapshot, SnapshotError, SnapshotSource,
};
use serde_json::{json, Value};
use solana_address::Address;

const GENESIS: i64 = 1_700_000_000;
const ID: u64 = 9;
const VERSION: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1 | WIDE_EXPERIMENTAL_VERSION_BIT;
const LARGE_BALANCE: u64 = 9_007_199_254_740_993;

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

fn account(data: Vec<u8>, lamports: u64, owner: Address) -> Account {
    Account {
        data,
        lamports,
        owner,
        executable: false,
    }
}

fn short(magic: &[u8; 8], size: usize) -> Vec<u8> {
    let mut data = vec![0; size];
    assert!(wr_arr(&mut data, 0, magic));
    assert!(wr_u64(&mut data, 8, ID));
    data
}

struct Fixture {
    request: Value,
    accounts: BTreeMap<Address, Option<Account>>,
    keeper: Address,
    pool: Address,
    season: Address,
    slot: Address,
}

impl Fixture {
    fn new() -> Self {
        let program = address(23);
        // Public Season PDA only. No signer/keypair fixture is used.
        let (season, bump) = fclient::addr::season_pda(&program, ID);
        let scope = Scope {
            program,
            season,
            deployment: Some(Deployment {
                program_version: VERSION,
                ruleset_hash: [0x77; 32],
            }),
        };
        let world = WorldId::derive_legacy_season(&season.to_bytes(), &program.to_bytes()).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let selected = SlotId {
            dest,
            bell: 10,
            faction: 0,
            i: 0,
        };
        let keeper = address(91);
        let ctx = AddrCtx {
            program: program.to_bytes(),
            season: season.to_bytes(),
        };
        let pool = Address::new_from_array(ctx.defence_pool());
        let claim = Address::new_from_array(
            ctx.of(&defence_claim_seed(&keeper_tag8(&keeper.to_bytes()), 0)),
        );
        let mut s = short(&S::MAGIC, S::SIZE);
        assert!(wr_u16(&mut s, S::LAYOUT_VERSION, 2));
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BUMP] = bump;
        assert!(wr_u16(&mut s, S::PROGRAM_VERSION, VERSION));
        assert!(wr_arr(&mut s, S::RULESET_HASH, &[0x77; 32]));
        assert!(wr_arr(&mut s, S::GENESIS_TS, &GENESIS.to_le_bytes()));
        assert!(wr_u32(&mut s, S::BELL_SECS, 600));
        assert!(wr_u32(&mut s, S::END_BELL, 10_000));
        assert!(wr_u32(&mut s, S::REVEAL_WINDOW, 600));
        assert!(wr_u32(&mut s, S::WINDOW_FROM_BELL, u32::MAX));
        assert!(wr_u32(&mut s, S::MIN_REVEAL_PRIORITY_MILLI, 433));
        assert!(wr_u32(&mut s, S::REVEAL_CU_LIMIT, 26_000));
        assert!(wr_u32(&mut s, S::REVEAL_LOADED_LIMIT, 1_048_576));
        assert!(wr_u32(&mut s, S::DEFENCE_CAP_MILLI, 2_000));
        s[S::LATENESS_SLOTS] = 4;
        let mut pool_data = short(&DP::MAGIC, DP::SIZE);
        assert!(wr_u64(&mut pool_data, DP::PER_BELL_REGION_CAP, 1_000_000));
        assert!(wr_u64(&mut pool_data, DP::PER_KEEPER_DAY_CAP, 2_000_000));
        assert!(wr_u64(&mut pool_data, DP::PAID_TOTAL, 11));
        assert!(wr_u64(&mut pool_data, DP::CLAIMS, 13));
        let slot_value = WideArrivalSlot {
            season_id: ID,
            dest,
            bell: 10,
            faction: 0,
            i: 0,
            transit_slot: 0,
            host: WideHostRef::new(dest, 3, 1, 2).unwrap(),
            citizen: [88; 32],
            unit: 0,
            stance: 0,
            tile: 5,
            retreat_bps: 0,
            dealt_bps: 0,
            dep_mass: 100_000,
            flags: 0,
            beneficiary: keeper.to_bytes(),
            rent_to: [90; 32],
            ev_slot: 110,
            ev_price: 10_000_000,
            ev_limit: 26_000,
            ev_loaded: 1_048_576,
            claimed: false,
        };
        let mut slot_data = vec![0; AS::SIZE];
        slot_value.write(&mut slot_data).unwrap();
        let mut anchor = short(&BA::MAGIC, BA::SIZE);
        assert!(wr_u32(&mut anchor, BA::BELL, 10));
        anchor[BA::REGION] = wide_region(dest.coord());
        assert!(wr_arr(&mut anchor, BA::A, &(GENESIS + 6_000).to_le_bytes()));
        assert!(wr_u64(&mut anchor, BA::SLOT, 100));
        let slot = selected.address(&scope);
        let accounts = BTreeMap::from([
            (season, Some(account(s, 1_000_000, program))),
            (
                keeper,
                Some(account(
                    vec![],
                    LARGE_BALANCE,
                    fclient::addr::system_program(),
                )),
            ),
            (pool, Some(account(pool_data, 500_384, program))),
            (
                claim,
                Some(account(vec![], 100, fclient::addr::system_program())),
            ),
            (slot, Some(account(slot_data, 416, program))),
            (selected.anchor(&scope), Some(account(anchor, 272, program))),
        ]);
        Self {
            request: json!({
                "program": program.to_string(), "season": season.to_string(),
                "deployment": {"program_version": VERSION.to_string(), "ruleset_hash": hex::encode([0x77; 32])},
                "keeper": keeper.to_string(), "day": "0", "min_slot": "80",
                "slots": [{"world": hex::encode(world.as_bytes()), "p": "129", "q": "0",
                    "bell": "10", "faction": "0", "i": "0"}]
            }),
            accounts,
            keeper,
            pool,
            season,
            slot,
        }
    }
    fn source(&self, mode: Mode) -> FakeSource {
        FakeSource {
            accounts: self.accounts.clone(),
            mode,
            calls: AtomicUsize::new(0),
            seen: Mutex::new(vec![]),
        }
    }
}

#[derive(Clone)]
enum Mode {
    Good,
    Error(SnapshotError),
    Partial,
    Stale,
    BadClock,
    BadRent,
    DifferentKeys,
    DifferentMinimum,
    NoRent,
}

struct FakeSource {
    accounts: BTreeMap<Address, Option<Account>>,
    mode: Mode,
    calls: AtomicUsize,
    seen: Mutex<Vec<(Vec<Address>, bool, u64)>>,
}

fn encoded(a: &Account) -> Value {
    json!({"lamports": a.lamports, "owner": a.owner.to_string(), "executable": a.executable,
        "data": [base64::engine::general_purpose::STANDARD.encode(&a.data), "base64"]})
}

impl SnapshotSource for FakeSource {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen
            .lock()
            .unwrap()
            .push((keys.to_vec(), with_rent, min_slot));
        Box::pin(async move {
            if let Mode::Error(error) = &self.mode {
                return Err(error.clone());
            }
            let mut returned_keys = keys.to_vec();
            if matches!(self.mode, Mode::DifferentKeys) {
                returned_keys.pop();
            }
            let mut values: Vec<Value> = returned_keys
                .iter()
                .map(|key| {
                    self.accounts
                        .get(key)
                        .and_then(Option::as_ref)
                        .map_or(Value::Null, encoded)
                })
                .collect();
            let context = if matches!(self.mode, Mode::Stale) {
                min_slot - 1
            } else {
                900
            };
            let clock = ClockSysvar {
                slot: if matches!(self.mode, Mode::BadClock) {
                    context + 1
                } else {
                    context
                },
                unix_timestamp: GENESIS + 7_200,
                ..ClockSysvar::default()
            };
            values.push(encoded(&account(
                clock.encode().to_vec(),
                1,
                sysvar_owner(),
            )));
            let include_rent = with_rent && !matches!(self.mode, Mode::NoRent);
            if include_rent {
                let rent = RentSysvar {
                    lamports_per_byte_year: 1,
                    exemption_threshold: 1.0,
                    burn_percent: 50,
                };
                let owner = if matches!(self.mode, Mode::BadRent) {
                    address(12)
                } else {
                    sysvar_owner()
                };
                values.push(encoded(&account(rent.encode().to_vec(), 1, owner)));
            }
            if matches!(self.mode, Mode::Partial) {
                values.pop();
            }
            let minimum = if matches!(self.mode, Mode::DifferentMinimum) {
                min_slot + 1
            } else {
                min_slot
            };
            parse_snapshot_response(
                &json!({"context": {"slot": context}, "value": values}),
                &returned_keys,
                include_rent,
                minimum,
            )
        })
    }

    fn label(&self) -> &'static str {
        "http://secret:credential@do-not-print.invalid/private"
    }
}

fn run(value: &Value, source: &FakeSource) -> Report {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(preview_bytes(&serde_json::to_vec(value).unwrap(), source))
}

fn no_json_numbers(value: &Value) {
    match value {
        Value::Number(_) => panic!("all preview integers must be strings"),
        Value::Array(values) => values.iter().for_each(no_json_numbers),
        Value::Object(values) => values.values().for_each(no_json_numbers),
        _ => {}
    }
}

#[test]
fn one_snapshot_with_clock_rent_and_exact_keys_produces_bounded_unsigned_facts() {
    let f = Fixture::new();
    let source = f.source(Mode::Good);
    let before = source.accounts.clone();
    let report = run(&f.request, &source);
    assert!(report.is_preview(), "{}", report.json());
    let json = report.json();
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    let request = parse_request(&serde_json::to_vec(&f.request).unwrap()).unwrap();
    assert_eq!(
        source.seen.lock().unwrap().as_slice(),
        &[(request.required_keys().to_vec(), true, 80)]
    );
    assert_eq!(source.accounts, before);
    assert_eq!(json["signed"], false);
    assert_eq!(json["automatic_send"], false);
    assert_eq!(json["fees_included"], false);
    assert_eq!(json["source"]["coherent"], true);
    assert_eq!(json["source"]["context_slot"], "900");
    assert_eq!(json["facts"]["predicted_paid"], "40711");
    assert_eq!(json["facts"]["creation_shortfall"], "156");
    assert_eq!(
        json["facts"]["predicted_balances"][0]["before"],
        LARGE_BALANCE.to_string()
    );
    assert_eq!(json["facts"]["slots"][0]["predicted_claimed"], true);
    no_json_numbers(json);
    let text = String::from_utf8(report.to_json_bytes()).unwrap();
    assert!(text.len() <= MAX_OUTPUT_BYTES);
    for forbidden in [
        "http://",
        "credential",
        "instruction",
        "transaction_bytes",
        "accounts\":",
        "signature",
    ] {
        assert!(!text.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn malformed_or_out_of_bounds_requests_never_read_source() {
    let f = Fixture::new();
    let mut cases = vec![];
    let mut value = f.request.clone();
    value["slots"] = json!([]);
    cases.push(value);
    let mut value = f.request.clone();
    value["slots"] = json!(vec![value["slots"][0].clone(); 7]);
    cases.push(value);
    let mut value = f.request.clone();
    value["slots"] = json!([value["slots"][0].clone(), value["slots"][0].clone()]);
    cases.push(value);
    for (field, input) in [
        ("faction", "6"),
        ("i", "255"),
        ("bell", "4294967296"),
        ("p", "4611686018427387905"),
        ("q", "-4611686018427387905"),
        ("p", "+1"),
        ("q", "-0"),
        ("bell", "01"),
        ("world", "01"),
    ] {
        let mut value = f.request.clone();
        value["slots"][0][field] = json!(input);
        cases.push(value);
    }
    for input in [
        json!(80),
        json!("18446744073709551616"),
        json!("-1"),
        json!("8e1"),
    ] {
        let mut value = f.request.clone();
        value["min_slot"] = input;
        cases.push(value);
    }
    let mut value = f.request.clone();
    value["seed"] = json!("not a supported input");
    cases.push(value);
    let mut value = f.request.clone();
    value["deployment"] = Value::Null;
    cases.push(value);
    let mut value = f.request.clone();
    value["deployment"]["program_version"] = json!("1");
    cases.push(value);
    let mut value = f.request.clone();
    value["slots"][0]["world"] = json!(hex::encode([1; 32]));
    cases.push(value);
    let mut value = f.request.clone();
    value["keeper"] = value["program"].clone();
    cases.push(value);
    let mut value = f.request.clone();
    value["keeper"] = json!([1, 2, 3]);
    cases.push(value);
    for value in cases {
        let source = f.source(Mode::Good);
        let report = run(&value, &source);
        assert!(!report.is_preview());
        assert_eq!(report.json()["stage"], "request");
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn request_reader_stops_at_limit_and_rejects_malformed_input() {
    let mut reader = std::io::Cursor::new(vec![b' '; MAX_REQUEST_BYTES + 100]);
    assert_eq!(
        read_request(&mut reader).unwrap_err().code,
        "RequestTooLarge"
    );
    assert_eq!(reader.position(), (MAX_REQUEST_BYTES + 1) as u64);
    for input in [b"{".as_slice(), b"null", b"[]", b"{} {}"] {
        assert!(parse_request(input).is_err());
    }
    struct BrokenReader;
    impl Read for BrokenReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("private file path must not escape"))
        }
    }
    assert_eq!(read_request(BrokenReader).unwrap_err().code, "InputRead");
}

#[test]
fn full_width_integer_strings_and_six_unique_slots_parse_without_loss() {
    let mut f = Fixture::new();
    f.request["min_slot"] = json!(u64::MAX.to_string());
    f.request["day"] = json!(u32::MAX.to_string());
    let mut slots = vec![];
    for faction in 0..6 {
        let mut slot = f.request["slots"][0].clone();
        slot["p"] = json!("4611686018427387904");
        slot["q"] = json!("-4611686018427387904");
        slot["faction"] = json!(faction.to_string());
        slots.push(slot);
    }
    f.request["slots"] = json!(slots);
    let request = parse_request(&serde_json::to_vec(&f.request).unwrap()).unwrap();
    assert_eq!(request.min_slot(), u64::MAX);
    assert!(request.required_keys().len() <= 16);
}

#[test]
fn only_explicit_numeric_loopback_http_with_safe_path_is_accepted() {
    for url in [
        "http://127.0.0.1:1",
        "http://127.0.0.1:65535/rpc-test_1.v2~",
        "http://[::1]:8899/",
    ] {
        assert!(validate_rpc_url(url).is_ok(), "{url}");
    }
    for url in [
        "https://127.0.0.1:8899",
        "http://localhost:8899",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:999999",
        "http://127.0.0.1:8@evil.invalid",
        "http://127.0.0.1:8/?token=secret",
        "http://127.0.0.1:8/#fragment",
        "http://127.0.0.1:8/%0a",
        "http://127.0.0.1:8/\r\nX: 1",
        "http://127.0.0.1:8/a b",
        "http://127.0.0.2:8/",
        "http://[::2]:8/",
        "http://127.0.0.1:8/\\evil",
    ] {
        assert!(validate_rpc_url(url).is_err(), "{url}");
    }
}

#[test]
fn partial_stale_bad_sysvars_and_mismatched_snapshots_never_retry() {
    let f = Fixture::new();
    for (mode, expected) in [
        (Mode::Partial, "SnapshotPartial"),
        (Mode::Stale, "SnapshotStale"),
        (Mode::BadClock, "SnapshotBadClock"),
        (Mode::BadRent, "SnapshotBadRent"),
        (Mode::DifferentKeys, "SnapshotKeySetMismatch"),
        (Mode::DifferentMinimum, "SnapshotRequestMismatch"),
        (Mode::NoRent, "SnapshotRentRequired"),
    ] {
        let source = f.source(mode);
        let report = run(&f.request, &source);
        assert_eq!(report.json()["blocker"]["code"], expected);
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        assert!(report.json()["facts"].is_null());
    }
}

#[test]
fn source_errors_and_labels_are_redacted_even_with_static_payloads() {
    let f = Fixture::new();
    for error in [
        SnapshotError::Rpc("http://user:secret@host/private\nserver-controlled".into()),
        SnapshotError::Malformed("http://user:secret@host/private"),
        SnapshotError::BadClock("http://user:secret@host/private"),
        SnapshotError::BadRent("http://user:secret@host/private"),
    ] {
        let source = f.source(Mode::Error(error));
        let report = run(&f.request, &source);
        let output = String::from_utf8(report.to_json_bytes()).unwrap();
        assert!(!output.contains("secret"));
        assert!(!output.contains("http://"));
        assert!(!output.contains("server-controlled"));
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn empty_pool_still_warns_that_selected_slots_are_consumed() {
    let mut f = Fixture::new();
    f.accounts
        .get_mut(&f.pool)
        .unwrap()
        .as_mut()
        .unwrap()
        .lamports = 384;
    let source = f.source(Mode::Good);
    let report = run(&f.request, &source);
    assert!(report.is_preview(), "{}", report.json());
    assert_eq!(report.json()["facts"]["predicted_paid"], "0");
    assert_eq!(
        report.json()["facts"]["slots"][0]["predicted_claimed"],
        true
    );
    assert!(report.json()["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("ZeroPaidStillConsumesSelectedSlots")));
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn deployment_pin_and_keeper_funding_block_without_extra_reads() {
    let mut f = Fixture::new();
    f.request["deployment"]["ruleset_hash"] = json!(hex::encode([2; 32]));
    let source = f.source(Mode::Good);
    assert_eq!(
        run(&f.request, &source).json()["blocker"]["code"],
        "RulesetHash"
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    let mut f = Fixture::new();
    f.accounts
        .get_mut(&f.keeper)
        .unwrap()
        .as_mut()
        .unwrap()
        .lamports = 155;
    let source = f.source(Mode::Good);
    let report = run(&f.request, &source);
    assert_eq!(report.json()["blocker"]["code"], "KeeperShortfall");
    assert_eq!(report.json()["blocker"]["needed"], "156");
    no_json_numbers(report.json());
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn missing_account_and_already_claimed_are_explicit_plan_blockers() {
    let mut f = Fixture::new();
    f.accounts.insert(f.season, None);
    let source = f.source(Mode::Good);
    assert_eq!(run(&f.request, &source).json()["blocker"]["code"], "Absent");
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    let mut f = Fixture::new();
    let account = f.accounts.get_mut(&f.slot).unwrap().as_mut().unwrap();
    let mut slot = WideArrivalSlot::read(&account.data).unwrap();
    slot.claimed = true;
    slot.write(&mut account.data).unwrap();
    let source = f.source(Mode::Good);
    let report = run(&f.request, &source);
    assert_eq!(report.json()["blocker"]["code"], "AlreadyClaimed");
    assert_eq!(report.json()["blocker"]["index"], "0");
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn oversized_snapshot_account_data_is_refused_before_planning() {
    let mut f = Fixture::new();
    f.accounts
        .get_mut(&f.keeper)
        .unwrap()
        .as_mut()
        .unwrap()
        .data = vec![0; MAX_SNAPSHOT_DATA_BYTES + 1];
    let source = f.source(Mode::Good);
    let report = run(&f.request, &source);
    assert_eq!(report.json()["blocker"]["code"], "SnapshotDataTooLarge");
    assert!(report.json()["facts"].is_null());
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}
