//! Literal public accounts only. No keys, signing, sockets or local chain.
#![cfg(all(feature = "snapshot", feature = "wide-records-experimental"))]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fclient::{
    addr::season_pda,
    original_outbound_snapshot as out,
    ports::ClockSysvar,
    snapshot::{parse_snapshot_response, sysvar_owner},
    Address,
};
use frontier_abi::{
    addr::AddrCtx,
    v2::layout::{write_header, AccountKind},
    world_index::{expedition::AccountResolver, ProvinceKey, WideCoord, WideHostRef},
};
use serde_json::{json, Value};

fn input(home: i64) -> Value {
    let program = Address::new_from_array([0x12; 32]);
    let season = season_pda(&program, 11).0;
    let ctx = AddrCtx {
        program: program.to_bytes(),
        season: season.to_bytes(),
    };
    let key = ProvinceKey::new(
        AccountResolver::for_season(&ctx).unwrap().adapter().world(),
        WideCoord::checked(home, 0).unwrap(),
    );
    let host = WideHostRef::new(key, 0, 1, 0).unwrap();
    json!({"schema":out::REQUEST_SCHEMA,"operation":"outbound_snapshot","cluster":"localnet",
        "program":program.to_string(),"season":season.to_string(),"season_id":"11",
        "deployment":{"program_version":"16388","ruleset_hash":"ab".repeat(32)},
        "host":hex::encode(host.to_bytes()),"wallet":Address::new_from_array([0x71;32]).to_string(),
        "origin":{"p":"128","q":"0","tile":30},"directions":vec![0;16],"min_slot":"100"})
}
fn parse(v: &Value) -> Result<out::Request, out::Error> {
    out::parse_request(&serde_json::to_vec(v).unwrap())
}
fn entry(owner: Address, bytes: &[u8]) -> Value {
    json!({"lamports":5000,"owner":owner.to_string(),"executable":false,"data":[STANDARD.encode(bytes),"base64"]})
}
fn response(r: &out::Request) -> Value {
    let mut values = Vec::new();
    for address in r.required_keys() {
        let role = r.source_keys().iter().position(|k| k == address);
        let mut b = if let Some(i) = role {
            let kind = [
                AccountKind::Season,
                AccountKind::Citizen,
                AccountKind::Holding,
                AccountKind::Province,
                AccountKind::Province,
            ][i];
            let mut b = vec![0; kind.size()];
            assert!(write_header(&mut b, kind, 11));
            if i == 0 {
                b[104..136].fill(0xab);
                b[138..140].copy_from_slice(&16388u16.to_le_bytes());
            }
            if i >= 3 {
                b[64..66].copy_from_slice(&128i16.to_le_bytes());
            }
            b
        } else {
            let key = r.route().iter().find(|(_, k)| k == address).unwrap().0;
            let mut b = vec![0; 4864];
            b[..8].copy_from_slice(b"PSFXWPV1");
            b[8..16].copy_from_slice(&11u64.to_le_bytes());
            b[16..18].copy_from_slice(&3u16.to_le_bytes());
            b[4736..4738].copy_from_slice(&1u16.to_le_bytes());
            b[4738] = 1;
            b[4739] = 15;
            b[4740..4772].copy_from_slice(key.world().as_bytes());
            b[4772..4789].copy_from_slice(&key.coord().sort_key());
            b[70] = b[4780];
            b[4800..4832].fill(0x66);
            b
        };
        if b.len() >= 4736 {
            b[264..272].copy_from_slice(&((1u64 << 61) - 1).to_le_bytes());
        }
        values.push(entry(r.program(), &b));
    }
    let clock = ClockSysvar {
        slot: 123,
        epoch_start_timestamp: 1800000000,
        epoch: 9,
        leader_schedule_epoch: 10,
        unix_timestamp: 1800006000,
    };
    values.push(entry(sysvar_owner(), &clock.encode()));
    json!({"context":{"slot":123},"value":values})
}
fn report(r: &out::Request, v: &Value) -> Value {
    out::report(
        r,
        &parse_snapshot_response(v, r.required_keys(), false, r.min_slot()).unwrap(),
    )
}
#[test]
fn exact_geometry_public_keys_and_shared_context_are_bounded() {
    let r = parse(&input(128)).unwrap();
    assert_eq!(r.source_keys()[3], r.source_keys()[4]);
    assert!(r.route().len() <= 4 && r.required_keys().len() <= 9);
    assert!(r.route()[0].0.coord().ring() > 128);
    let v = response(&r);
    let result = report(&r, &v);
    assert_eq!(result["status"], "snapshot", "{result}");
    assert_eq!(result["source"]["context_slot"], "123");
    assert_eq!(result["clock"]["slot"], "123");
    assert_eq!(result["source"]["authority_verified"], false);
    for k in [
        "dispatch_available",
        "executable",
        "admitted",
        "signed",
        "enqueued",
    ] {
        assert_eq!(result[k], false);
    }
    assert_eq!(result["accounts"]["home"], result["accounts"]["standing"]);
    let remote = parse(&input(127)).unwrap();
    assert_ne!(remote.source_keys()[3], remote.source_keys()[4]);
    assert!(remote.required_keys().contains(&remote.source_keys()[3]));
}
#[test]
fn invalid_request_never_reaches_a_read() {
    for patch in [
        json!({"directions":[]}),
        json!({"directions":[6]}),
        json!({"directions":vec![0;33]}),
        json!({"directions":vec![0;24]}),
        json!({"directions":[0]}),
        json!({"season_id":"011"}),
        json!({"origin":{"p":"129","q":"0","tile":30}}),
        json!({"min_slot":"-1"}),
        json!({"wallet":Address::new_from_array([0x12;32]).to_string()}),
        json!({"operation":"send"}),
    ] {
        let mut v = input(128);
        for (k, x) in patch.as_object().unwrap() {
            v[k] = x.clone();
        }
        assert!(parse(&v).is_err(), "{v}");
    }
    let mut v = input(128);
    v["secret"] = json!("not-accepted");
    assert!(parse(&v).is_err());
}
#[test]
fn missing_source_foreign_owner_wrong_deployment_and_route_identity_refuse() {
    let r = parse(&input(128)).unwrap();
    for (index, change, code) in [
        (0, Value::Null, "SourceAbsent"),
        (
            1,
            json!({"owner":Address::new_from_array([0x72;32]).to_string()}),
            "SnapshotAccount",
        ),
        (2, json!({"executable":true}), "SnapshotAccount"),
    ] {
        let mut v = response(&r);
        if change.is_null() {
            v["value"][index] = change;
        } else {
            for (k, x) in change.as_object().unwrap() {
                v["value"][index][k] = x.clone();
            }
        }
        let result = report(&r, &v);
        assert_eq!(result["status"], "blocked");
        assert_eq!(result["blocker"]["code"], code);
    }
    let mut v = response(&r);
    let mut bytes = STANDARD
        .decode(v["value"][0]["data"][0].as_str().unwrap())
        .unwrap();
    bytes[104] ^= 1;
    v["value"][0]["data"][0] = json!(STANDARD.encode(bytes));
    assert_eq!(report(&r, &v)["blocker"]["code"], "DeploymentMismatch");
    let i = r
        .required_keys()
        .iter()
        .position(|a| *a == r.route()[0].1)
        .unwrap();
    let mut v = response(&r);
    v["value"][i] = Value::Null;
    let result = report(&r, &v);
    assert_eq!(result["status"], "snapshot");
    assert!(result["route"][0]["account"].is_null());
    let mut v = response(&r);
    let mut bytes = STANDARD
        .decode(v["value"][i]["data"][0].as_str().unwrap())
        .unwrap();
    bytes[4772] ^= 1;
    v["value"][i]["data"][0] = json!(STANDARD.encode(bytes));
    assert_eq!(report(&r, &v)["blocker"]["code"], "RouteIdentity");
}
#[test]
fn wrong_clock_slot_partial_response_and_cross_request_snapshot_cannot_merge() {
    let r = parse(&input(128)).unwrap();
    let v = response(&r);
    let mut stale = v.clone();
    stale["context"]["slot"] = json!(99);
    assert!(parse_snapshot_response(&stale, r.required_keys(), false, r.min_slot()).is_err());
    let mut wrong_clock = v.clone();
    wrong_clock["context"]["slot"] = json!(124);
    assert!(parse_snapshot_response(&wrong_clock, r.required_keys(), false, r.min_slot()).is_err());
    let mut partial = v.clone();
    partial["value"].as_array_mut().unwrap().pop();
    assert!(parse_snapshot_response(&partial, r.required_keys(), false, r.min_slot()).is_err());
    let s = parse_snapshot_response(&v, r.required_keys(), false, r.min_slot()).unwrap();
    let remote = parse(&input(127)).unwrap();
    assert_eq!(
        out::report(&remote, &s)["blocker"]["code"],
        "SnapshotMismatch"
    );
}

#[test]
fn transport_requests_exact_deduplicated_set_and_clock_in_one_call() {
    use fclient::snapshot::{Snapshot, SnapshotError, SnapshotPort};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct PublicResponse {
        keys: Vec<Address>,
        snapshot: Snapshot,
        calls: AtomicUsize,
    }
    impl SnapshotPort for PublicResponse {
        async fn snapshot(
            &self,
            keys: &[Address],
            with_rent: bool,
            min_slot: u64,
        ) -> Result<Snapshot, SnapshotError> {
            assert_eq!(keys, self.keys);
            assert!(!with_rent);
            assert_eq!(min_slot, 100);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.snapshot.clone())
        }
    }
    let r = parse(&input(128)).unwrap();
    let source = PublicResponse {
        keys: r.required_keys().to_vec(),
        snapshot: parse_snapshot_response(&response(&r), r.required_keys(), false, 100).unwrap(),
        calls: AtomicUsize::new(0),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let result = runtime.block_on(out::read(&r, &source));
    assert_eq!(result["status"], "snapshot");
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
}
