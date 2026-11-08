//! Real RpcPort requests against an ephemeral loopback HTTP fixture.
//! Fixed public addresses and bytes only; no validator or keeper startup.
#![cfg(feature = "wide-world-experimental")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine as _;
use fclient::ports::ClockSysvar;
use fclient::rpc::RpcPort;
use keeper_core::widesnapshot::{
    rent_sysvar, sysvar_owner, RentSysvar, SnapshotError, SnapshotPort, MAX_SNAPSHOT_KEYS,
};
use serde_json::{json, Value};
use solana_address::Address;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle, time::timeout};

const MIN_SLOT: u64 = 100;
const CONTEXT_SLOT: u64 = 123;

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

fn clock(slot: u64) -> ClockSysvar {
    ClockSysvar {
        slot,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 9,
        leader_schedule_epoch: 10,
        unix_timestamp: 1_700_000_042,
    }
}

fn rent() -> RentSysvar {
    RentSysvar {
        lamports_per_byte_year: 3_480,
        exemption_threshold: 2.0,
        burn_percent: 50,
    }
}

fn account(owner: Address, bytes: &[u8]) -> Value {
    json!({
        "lamports": 5000,
        "owner": owner.to_string(),
        "executable": false,
        "rentEpoch": 0,
        "data": [base64::engine::general_purpose::STANDARD.encode(bytes), "base64"],
        "space": bytes.len(),
    })
}

fn response(context_slot: u64, clock_slot: u64, with_rent: bool) -> Value {
    let mut values = vec![
        account(address(42), &[1, 2, 3, 4]),
        Value::Null,
        account(sysvar_owner(), &clock(clock_slot).encode()),
    ];
    if with_rent {
        values.push(account(sysvar_owner(), &rent().encode()));
    }
    json!({"context": {"slot": context_slot}, "value": values})
}

#[derive(Clone)]
struct ServerState {
    requests: Arc<Mutex<Vec<Value>>>,
    result: Value,
}

async fn handle(State(state): State<ServerState>, Json(request): Json<Value>) -> Json<Value> {
    state.requests.lock().unwrap().push(request.clone());
    Json(json!({"jsonrpc": "2.0", "id": request["id"], "result": state.result}))
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(result: Value) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind test server on loopback");
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = ServerState {
            requests: requests.clone(),
            result,
        };
        let app = Router::new().route("/", post(handle)).with_state(state);
        let (shutdown, receive) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receive.await;
                })
                .await
                .expect("serve loopback fixture");
        });
        Self {
            url,
            requests,
            shutdown,
            task,
        }
    }

    fn port(&self) -> RpcPort {
        RpcPort::new(self.url.clone(), address(42))
    }

    async fn finish(self) -> Vec<Value> {
        self.shutdown.send(()).expect("server still running");
        timeout(Duration::from_secs(5), self.task)
            .await
            .expect("loopback server shutdown timeout")
            .expect("loopback server task");
        let requests = self.requests.lock().unwrap().clone();
        requests
    }
}

fn assert_one_request(requests: &[Value], keys: &[Address], with_rent: bool, min_slot: u64) {
    assert_eq!(
        requests.len(),
        1,
        "snapshot must issue exactly one HTTP request"
    );
    let request = &requests[0];
    assert_eq!(request["jsonrpc"], "2.0");
    assert_eq!(request["method"], "getMultipleAccounts");
    let mut expected: Vec<String> = keys.iter().map(ToString::to_string).collect();
    expected.push(fclient::addr::clock_sysvar().to_string());
    if with_rent {
        expected.push(rent_sysvar().to_string());
    }
    assert_eq!(request["params"][0], json!(expected));
    assert_eq!(
        request["params"][1],
        json!({
            "encoding": "base64", "commitment": "confirmed", "minContextSlot": min_slot,
        })
    );
}

#[tokio::test]
async fn one_rpc_response_binds_accounts_clock_rent_and_actual_context() {
    let server = Server::start(response(CONTEXT_SLOT, CONTEXT_SLOT, true)).await;
    let keys = [address(11), address(12)];
    let snapshot = timeout(
        Duration::from_secs(5),
        server.port().snapshot(&keys, true, MIN_SLOT),
    )
    .await
    .expect("snapshot timeout")
    .expect("valid snapshot");
    assert_eq!(snapshot.meta().context_slot(), CONTEXT_SLOT);
    assert_ne!(snapshot.meta().context_slot(), MIN_SLOT);
    assert_eq!(snapshot.meta().min_slot(), MIN_SLOT);
    assert_eq!(snapshot.meta().commitment(), "confirmed");
    assert_eq!(snapshot.meta().keys(), keys.len());
    assert!(snapshot.meta().rent_included());
    assert_eq!(snapshot.clock(), clock(CONTEXT_SLOT));
    assert_eq!(snapshot.rent(), Some(rent()));
    assert_eq!(snapshot.accounts().len(), 2);
    let actual = snapshot.accounts()[&keys[0]].as_ref().unwrap();
    assert_eq!(actual.owner, address(42));
    assert_eq!(actual.lamports, 5000);
    assert_eq!(actual.data, vec![1, 2, 3, 4]);
    assert!(!actual.executable);
    assert_eq!(snapshot.accounts()[&keys[1]], None);
    assert!(snapshot.reads().coherent_snapshot().is_some());
    assert_one_request(&server.finish().await, &keys, true, MIN_SLOT);
}

#[tokio::test]
async fn rpc_snapshot_without_rent_still_uses_one_response() {
    let server = Server::start(response(CONTEXT_SLOT, CONTEXT_SLOT, false)).await;
    let keys = [address(11), address(12)];
    let snapshot = timeout(
        Duration::from_secs(5),
        server.port().snapshot(&keys, false, MIN_SLOT),
    )
    .await
    .expect("snapshot timeout")
    .expect("valid snapshot");
    assert_eq!(snapshot.meta().context_slot(), CONTEXT_SLOT);
    assert!(!snapshot.meta().rent_included());
    assert_eq!(snapshot.rent(), None);
    assert!(snapshot.reads().coherent_snapshot().is_some());
    assert_one_request(&server.finish().await, &keys, false, MIN_SLOT);
}

#[tokio::test]
async fn rpc_snapshot_refuses_context_below_requested_minimum() {
    let server = Server::start(response(MIN_SLOT - 1, MIN_SLOT - 1, true)).await;
    let keys = [address(11), address(12)];
    let result = timeout(
        Duration::from_secs(5),
        server.port().snapshot(&keys, true, MIN_SLOT),
    )
    .await
    .expect("snapshot timeout");
    assert_eq!(
        result.unwrap_err(),
        SnapshotError::Stale {
            context_slot: MIN_SLOT - 1,
            min_slot: MIN_SLOT,
        }
    );
    assert_one_request(&server.finish().await, &keys, true, MIN_SLOT);
}

#[tokio::test]
async fn rpc_snapshot_refuses_clock_from_another_slot() {
    let server = Server::start(response(CONTEXT_SLOT, CONTEXT_SLOT - 1, true)).await;
    let keys = [address(11), address(12)];
    let result = timeout(
        Duration::from_secs(5),
        server.port().snapshot(&keys, true, MIN_SLOT),
    )
    .await
    .expect("snapshot timeout");
    assert!(matches!(result, Err(SnapshotError::BadClock(_))));
    assert_one_request(&server.finish().await, &keys, true, MIN_SLOT);
}

#[tokio::test]
async fn rpc_snapshot_refuses_foreign_owned_sysvars() {
    for index in [2usize, 3] {
        let mut fixture = response(CONTEXT_SLOT, CONTEXT_SLOT, true);
        fixture["value"][index]["owner"] = json!(address(99).to_string());
        let server = Server::start(fixture).await;
        let keys = [address(11), address(12)];
        let result = timeout(
            Duration::from_secs(5),
            server.port().snapshot(&keys, true, MIN_SLOT),
        )
        .await
        .expect("snapshot timeout");
        match index {
            2 => assert!(matches!(result, Err(SnapshotError::BadClock(_)))),
            _ => assert!(matches!(result, Err(SnapshotError::BadRent(_)))),
        }
        assert_one_request(&server.finish().await, &keys, true, MIN_SLOT);
    }
}

#[tokio::test]
async fn oversized_snapshot_is_rejected_before_any_http_request() {
    let server = Server::start(Value::Null).await;
    let keys: Vec<Address> = (0..=MAX_SNAPSHOT_KEYS).map(|i| address(i as u8)).collect();
    for with_rent in [false, true] {
        let result = timeout(
            Duration::from_secs(5),
            server.port().snapshot(&keys, with_rent, MIN_SLOT),
        )
        .await
        .expect("snapshot timeout");
        assert_eq!(
            result.unwrap_err(),
            SnapshotError::TooManyKeys {
                n: MAX_SNAPSHOT_KEYS + 1,
                max: MAX_SNAPSHOT_KEYS,
            }
        );
    }
    assert!(
        server.finish().await.is_empty(),
        "oversized request reached HTTP server"
    );
}
