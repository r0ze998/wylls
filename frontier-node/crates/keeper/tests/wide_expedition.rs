//! Isolated read-only tests. Literal PUBLIC identities and storage bytes only:
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
    wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT, ProvinceKey, WideCoord, WideHostRef, WideProvince,
    WideRoster, WideTransit,
};
use keeper_core::wideduty::{Block, Deployment, Reads, Scope};
use keeper_core::wideexpedition::{
    inspect, plan, EngineFacts, Next, Observed, ReadPlan, Refusal, Selection,
};
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

#[test]
fn canonical_original_and_wide_account_families_never_alias() {
    let f = Fixture::new();
    let ctx = AddrCtx {
        program: f.scope.program.to_bytes(),
        season: f.scope.season.to_bytes(),
    };
    assert_eq!(f.keys.holding().to_bytes(), ctx.holding(128, 0, 1));
    assert_eq!(f.keys.home().to_bytes(), ctx.province(128, 0));
    assert_ne!(
        f.keys.holding().to_bytes(),
        frontier_abi::world_index::holding::holding_address(&ctx, f.selected.host.key().coord(), 1)
    );
    assert_eq!(f.keys.keys().len(), 10);
    let mut selected = f.selected;
    selected.host = WideHostRef::new(selected.standing, 1, 2, 0).unwrap();
    assert_eq!(
        ReadPlan::new(&f.scope, selected),
        Err(Refusal::HostMustBeOriginal)
    );
    selected = f.selected;
    selected.standing = selected.host.key();
    assert_eq!(
        ReadPlan::new(&f.scope, selected),
        Err(Refusal::StandingMustBeWide)
    );
}

#[test]
fn resident_return_predicts_original_reserve_but_never_admits_or_emits_wire() {
    let f = Fixture::new();
    let mut report = plan(&f.scope, f.selected, &f.reads).unwrap();
    assert_eq!(report.next, Next::ReturnOriginalReserve);
    assert!(matches!(
        report.observed,
        Observed::Resident {
            return_units: Some(12),
            reserve_after: Some(24),
            ..
        }
    ));
    report.engine = Some(EngineFacts {
        feed_writes_allowed: true,
        kind_allowed: true,
        already_pending: false,
        care_unresolved: false,
    });
    let json = report.describe();
    for key in [
        "admitted",
        "signed",
        "enqueued",
        "automatic_send",
        "dispatch_available",
        "completion_proven",
        "provenance_verified",
        "history_verified",
        "coherent",
    ] {
        assert_eq!(json[key], false, "{key}");
    }
    assert!(json["tag"].is_null() && json["instruction"].is_null());
    assert!(json["denials"]
        .as_array()
        .unwrap()
        .contains(&json!("OriginalHostDispatchUnavailable")));
}

#[test]
fn dissolve_and_leave_resolve_are_distinct_prerequisites() {
    let mut f = Fixture::new();
    f.entry(E::STATE_ROSTER, EntryOp::None);
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads).unwrap().next,
        Next::OwnerDissolve
    );
    f.entry(E::STATE_ROSTER, EntryOp::Leave);
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads).unwrap().next,
        Next::ResolveVoluntaryLeave
    );
    f.entry(E::STATE_DEPARTED, EntryOp::Leave);
    assert!(wr_u32(f.data(f.keys.standing()), P::RESOLVED_NEXT, 9));
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads).unwrap().next,
        Next::ResolveVoluntaryLeave
    );
}

#[test]
fn capture_generation_issuance_and_owner_are_not_interchangeable() {
    let mut f = Fixture::new();
    let site = P::site(f.selected.host.site() as usize);
    f.data(f.keys.home())[site + SM::STATE] = SM::STATE_HOLDING;
    f.data(f.keys.home())[site + SM::GEN] = f.selected.host.gen() + 1;
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::State(Block::CapturePending))
    );
    let mut f = Fixture::new();
    f.data(f.keys.holding())[H::GEN] += 1;
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::SourceGeneration)
    );
    let mut f = Fixture::new();
    assert!(wr_u32(f.data(f.keys.holding()), H::HOST_SEQ, 0));
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::HostNotIssued)
    );
    let mut f = Fixture::new();
    assert!(wr_arr(
        f.data(f.keys.holding()),
        H::OWNER_CITIZEN,
        &a(99).to_bytes()
    ));
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::OwnerChanged)
    );
}

#[test]
fn raw_retirement_payload_cannot_be_voluntary_leave() {
    for offset in [E::OP_A, E::OP_B, E::OP_TROOPS, E::OP_REF] {
        let mut f = Fixture::new();
        f.data(f.keys.standing())[P::entry(2) + offset] = 1;
        assert_eq!(
            plan(&f.scope, f.selected, &f.reads),
            Err(Refusal::LeavePayloadUnsupported)
        );
    }
}

#[test]
fn full_roster_identity_required_and_absence_is_not_completion() {
    let mut f = Fixture::new();
    f.data(f.keys.roster())[wide_roster::slot(2) + 55] ^= 1;
    assert!(matches!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::State(Block::RosterUnpaired))
    ));
    let mut f = Fixture::new();
    f.reads.accounts.insert(f.keys.roster(), None);
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::ResidentMissingHistoryRequired)
    );
}

#[test]
fn owned_bridge_uses_departure_owner_and_rejects_v1_or_orphan() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    // A captured source does not silently redirect the bridge's original owner.
    f.data(f.keys.holding())[H::GEN] += 1;
    assert!(wr_arr(
        f.data(f.keys.holding()),
        H::OWNER_CITIZEN,
        &a(99).to_bytes()
    ));
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads).unwrap().next,
        Next::OriginalDepartureSettlement
    );
    let mut selected = f.selected;
    selected.original_owner = a(99);
    f.reads.accounts.insert(selected.original_owner, None);
    assert_eq!(
        plan(&f.scope, selected, &f.reads),
        Err(Refusal::BridgeOwner)
    );
    *f.data(f.keys.bridges()[0]) = bridge.common().to_bytes().to_vec();
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::OwnedBridgeRequired)
    );
    let mut f = Fixture::new();
    f.bridge();
    f.data(f.keys.holding())[H::transit(0)..H::transit(0) + 96].fill(0);
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::OrphanBridge)
    );
}

#[test]
fn malformed_occupancy_foreign_owner_and_missing_reads_fail_closed() {
    let mut f = Fixture::new();
    f.data(f.keys.holding())[H::transit(3)] = 255;
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::InvalidTransitOccupancy)
    );
    let mut f = Fixture::new();
    f.reads
        .accounts
        .get_mut(&f.keys.holding())
        .unwrap()
        .as_mut()
        .unwrap()
        .owner = a(99);
    assert!(matches!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::State(Block::ForeignOwner(_)))
    ));
    let mut f = Fixture::new();
    f.reads.accounts.remove(&f.keys.bridges()[3]);
    assert!(matches!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::MissingReads(_))
    ));
}

#[test]
fn snapshot_seal_clock_and_deployment_are_rechecked() {
    let f = Fixture::new();
    let snapshot = snapshot(&f);
    let mut reads = snapshot.reads();
    assert_eq!(
        plan(&f.scope, f.selected, &reads).unwrap().context_slot,
        Some(100)
    );
    reads.clock.as_mut().unwrap().unix_timestamp += 1;
    assert_eq!(
        plan(&f.scope, f.selected, &reads).unwrap().context_slot,
        None
    );
    reads.clock = None;
    assert_eq!(
        plan(&f.scope, f.selected, &reads),
        Err(Refusal::ClockMissing)
    );
    let mut scope = f.scope.clone();
    scope.deployment = None;
    assert_eq!(
        plan(&scope, f.selected, &f.reads),
        Err(Refusal::State(Block::DeploymentUnpinned))
    );
}

struct Source {
    snapshot: Snapshot,
    calls: AtomicUsize,
    fail: bool,
}
impl SnapshotSource for Source {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(keys.len(), 10);
        assert!(!rent);
        assert_eq!(min_slot, 80);
        Box::pin(async move {
            if self.fail {
                Err(SnapshotError::Unsupported)
            } else {
                Ok(self.snapshot.clone())
            }
        })
    }
}

#[tokio::test]
async fn one_snapshot_call_no_retry_or_other_capability() {
    let f = Fixture::new();
    let mut source = Source {
        snapshot: snapshot(&f),
        calls: AtomicUsize::new(0),
        fail: false,
    };
    assert_eq!(
        inspect(&source, &f.scope, f.selected, 80)
            .await
            .unwrap()
            .context_slot,
        Some(100)
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    source.fail = true;
    assert_eq!(
        inspect(&source, &f.scope, f.selected, 80).await,
        Err(Refusal::Snapshot(SnapshotError::Unsupported))
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn destroyed_origin_needs_settlement_or_cleanup_evidence() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let ctx = AddrCtx {
        program: f.scope.program.to_bytes(),
        season: f.scope.season.to_bytes(),
    };
    let destroyed = bridge.settle_origin(&ctx, true, None).unwrap();
    *f.data(f.keys.bridges()[0]) = destroyed.to_bytes().to_vec();
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads).unwrap().next,
        Next::OriginDestroyedSettlementOrCleanupEvidence
    );
}

// Canonical receipt-only log fixtures, not authenticated transitions. Public
// digests and public address hashing only; no signing or crypto-secret fixture.
fn receipt_pair(
    f: &Fixture,
    action: frontier_abi::world_index::expedition_resident_event::Action,
    prior: frontier_abi::world_index::event::WideLink,
) -> (Vec<u8>, Vec<u8>, frontier_abi::world_index::event::WideLink) {
    use frontier_abi::{
        log,
        world_index::{event, expedition_resident_event as re},
    };
    let receipt = re::Receipt::new([action as u8; 32], [9; 32]);
    let body = |wide: bool| {
        let mut b = vec![
            if wide {
                event::WIDE_EVENT_VERSION
            } else {
                log::VERSION
            },
            if wide {
                re::WIDE_KIND
            } else {
                re::ORIGINAL_KIND
            },
        ];
        b.extend_from_slice(&10u32.to_le_bytes());
        b.extend_from_slice(&[re::VERSION, action as u8, 0, 0]);
        b.extend_from_slice(&f.selected.host.to_bytes());
        b.extend_from_slice(&f.selected.original_owner.to_bytes());
        b.extend_from_slice(&f.keys.holding().to_bytes());
        b.extend_from_slice(&f.selected.standing.to_bytes());
        b.extend_from_slice(&f.keys.standing().to_bytes());
        b.extend_from_slice(&[2, 2]);
        b.extend_from_slice(&12_345u32.to_le_bytes());
        b.extend_from_slice(
            &(if action == re::Action::Dissolve {
                10u32
            } else {
                9u32
            })
            .to_le_bytes(),
        );
        b.extend_from_slice(
            &(if action == re::Action::Dissolve {
                0u32
            } else {
                12u32
            })
            .to_le_bytes(),
        );
        for digest in [receipt.operation_id, receipt.input, receipt.output] {
            b.extend_from_slice(&digest);
        }
        assert_eq!(b.len(), re::BODY_LEN);
        b
    };
    let mut original = body(false);
    let original_links: Vec<_> = action
        .entities()
        .iter()
        .map(|entity| log::advance(*entity, 0, &[0; 32], &original).unwrap())
        .collect();
    original.push(original_links.len() as u8);
    for link in original_links {
        original.push(link.entity as u8);
        original.extend_from_slice(&link.seq.to_le_bytes());
        original.extend_from_slice(&link.head);
    }
    let mut wide = body(true);
    let link = event::advance(prior.entity, prior.seq, &prior.head, &wide).unwrap();
    wide.push(1);
    wide.push(link.entity as u8);
    wide.extend_from_slice(&link.seq.to_le_bytes());
    wide.extend_from_slice(&link.head);
    (original, wide, link)
}

fn wide_event(
    f: &Fixture,
    kind: frontier_abi::world_index::event::WideKind,
    prior: frontier_abi::world_index::event::WideLink,
) -> (Vec<u8>, frontier_abi::world_index::event::WideLink) {
    use frontier_abi::world_index::event as ev;
    let payload = if kind == ev::WideKind::ProvinceClosed {
        ev::province_closed_payload(&[11; 32], 0).to_vec()
    } else {
        ev::resolve_payload(&[1; 32], &[2; 32], 11, 0, 0, false).to_vec()
    };
    let mut body = vec![0; ev::MAX_BODY];
    let len = ev::write_body(
        kind,
        10,
        &f.selected.standing.to_bytes(),
        &payload,
        &mut body,
    )
    .unwrap();
    body.truncate(len);
    let link = ev::advance(prior.entity, prior.seq, &prior.head, &body).unwrap();
    (
        ev::encode(kind, 10, &f.selected.standing.to_bytes(), &payload, &[link]).unwrap(),
        link,
    )
}

fn feed(f: &Fixture, seq: u64, records: &[(&[u8], &[u8])]) -> fclient::ports::TxRecord {
    let b64 = base64::engine::general_purpose::STANDARD;
    let lines = records
        .iter()
        .map(|(tag, body)| format!("Program data: {} {}", b64.encode(tag), b64.encode(body)));
    fclient::ports::TxRecord {
        seq,
        slot: 100 + seq,
        signature: fclient::ports::Signature::default(),
        block_time: GENESIS + 6000,
        tx: vec![],
        logs: fclient::log::in_frame(&f.scope.program, lines),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn observer(f: &Fixture, resident: bool) -> keeper_core::wideindex::WideObserver {
    use keeper_core::wideindex::{Limits, Scope, WideObserver};
    let scope = Scope {
        program: f.scope.program,
        season: f.scope.season,
        world: f.selected.standing.world(),
        source: "literal public receipt bytes, not authenticated history".into(),
    };
    if resident {
        WideObserver::new_with_resident(scope, Limits::default()).unwrap()
    } else {
        WideObserver::new(scope, Limits::default())
    }
}
fn zero_link() -> frontier_abi::world_index::event::WideLink {
    frontier_abi::world_index::event::WideLink {
        entity: frontier_abi::world_index::event::WideEntity::Province,
        seq: 0,
        head: [0; 32],
    }
}

#[test]
fn resident_observer_tracks_shared_chain_without_creating_fake_wide_hosts() {
    use frontier_abi::world_index::{
        event::{WideKind, WideTarget},
        expedition_resident_event::Action,
    };
    let f = Fixture::new();
    let mut o = observer(&f, true);
    let (original, wide, first) = receipt_pair(&f, Action::Dissolve, zero_link());
    let (resolve, second) = wide_event(&f, WideKind::Resolve, first);
    let (original_return, wide_return, third) = receipt_pair(&f, Action::Return, second);
    let txs = [
        feed(&f, 1, &[(b"PS2", &original), (b"PSW1", &wide)]),
        feed(&f, 2, &[(b"PSW1", &resolve)]),
        feed(
            &f,
            3,
            &[(b"PS2", &original_return), (b"PSW1", &wide_return)],
        ),
    ];
    assert_eq!(o.observe_page(&txs, &f.scope.program), 3, "{}", o.status());
    assert!(o.model.blocked().is_none());
    assert_eq!(
        o.chain(WideTarget::Province(f.selected.standing))
            .unwrap()
            .head,
        third.head
    );
    assert_eq!(o.resident_selection(), Some(f.selected));
    assert!(o.model.hosts.is_empty() && o.model.holdings.is_empty());
    assert_eq!(o.status()["resident_receipts"]["transactions"], 2);
    assert_eq!(
        o.status()["resident_receipts"]["latest"]["action"],
        "Return"
    );
    for key in [
        "original_history_verified",
        "source_authenticated",
        "completion_proven",
        "dispatch_available",
        "automatic_writes",
    ] {
        assert_eq!(o.status()["resident_receipts"][key], false);
    }
    assert_eq!(o.observe_page(&txs, &f.scope.program), 0);
    assert_eq!(o.status()["resident_receipts"]["transactions"], 2);
}

#[test]
fn generic_observer_and_unpaired_or_mixed_receipts_fail_closed() {
    use frontier_abi::world_index::{event::WideKind, expedition_resident_event::Action};
    let f = Fixture::new();
    let (original, wide, link) = receipt_pair(&f, Action::Dissolve, zero_link());
    let pair = feed(&f, 1, &[(b"PS2", &original), (b"PSW1", &wide)]);
    let mut generic = observer(&f, false);
    assert_eq!(generic.observe_page(&[pair], &f.scope.program), 0);
    assert!(generic.model.blocked().is_some());
    let (resolve, _) = wide_event(&f, WideKind::Resolve, link);
    for tx in [
        feed(&f, 1, &[(b"PS2", &original)]),
        feed(&f, 1, &[(b"PSW1", &wide)]),
        feed(
            &f,
            1,
            &[(b"PS2", &original), (b"PSW1", &wide), (b"PSW1", &resolve)],
        ),
    ] {
        let mut o = observer(&f, true);
        assert_eq!(o.observe_page(&[tx], &f.scope.program), 0);
        assert!(o.model.blocked().is_some());
        assert_eq!(o.resident_selection(), None);
        assert_eq!(o.status()["resident_receipts"]["transactions"], 0);
    }
}

#[test]
fn resident_rollback_chain_mismatch_and_closed_province_are_atomic() {
    use frontier_abi::world_index::{
        event::{WideKind, WideTarget},
        expedition_resident_event::Action,
    };
    let f = Fixture::new();
    let (original, wide, link) = receipt_pair(&f, Action::Dissolve, zero_link());
    let mut tx = feed(&f, 1, &[(b"PS2", &original), (b"PSW1", &wide)]);
    tx.err = Some("rolled back".into());
    let mut o = observer(&f, true);
    assert_eq!(o.observe_page(&[tx], &f.scope.program), 0);
    assert_eq!(o.resident_selection(), None);
    let good = feed(&f, 2, &[(b"PS2", &original), (b"PSW1", &wide)]);
    assert_eq!(
        o.observe_page(&[good], &f.scope.program),
        1,
        "{}",
        o.status()
    );
    let before = o.chain(WideTarget::Province(f.selected.standing));
    let (bad_original, mut bad_wide, _) = receipt_pair(&f, Action::Return, link);
    *bad_wide.last_mut().unwrap() ^= 1;
    assert_eq!(
        o.observe_page(
            &[feed(
                &f,
                3,
                &[(b"PS2", &bad_original), (b"PSW1", &bad_wide)]
            )],
            &f.scope.program
        ),
        0
    );
    assert_eq!(o.chain(WideTarget::Province(f.selected.standing)), before);
    assert_eq!(o.status()["resident_receipts"]["transactions"], 1);
    let mut o = observer(&f, true);
    let (closed, closed_link) = wide_event(&f, WideKind::ProvinceClosed, zero_link());
    assert_eq!(
        o.observe_page(&[feed(&f, 1, &[(b"PSW1", &closed)])], &f.scope.program),
        1
    );
    let (original, wide, _) = receipt_pair(&f, Action::Return, closed_link);
    assert_eq!(
        o.observe_page(
            &[feed(&f, 2, &[(b"PS2", &original), (b"PSW1", &wide)])],
            &f.scope.program
        ),
        0
    );
    assert!(o.model.blocked().is_some());
    assert_eq!(o.resident_selection(), None);
}

#[test]
fn resident_observer_scope_input_and_chain_caps_are_enforced() {
    use frontier_abi::world_index::expedition_resident_event::Action;
    use keeper_core::wideindex::{Limits, Scope, WideObserver, MAX_CHAIN_KEYS};
    let mut f = Fixture::new();
    let scope = Scope {
        program: f.scope.program,
        season: f.scope.season,
        world: f.selected.standing.world(),
        source: "literal records".into(),
    };
    let mut wrong = scope.clone();
    wrong.season = a(99);
    assert!(WideObserver::new_with_resident(wrong, Limits::default()).is_err());
    let mut capped = WideObserver::new_with_resident(
        scope,
        Limits {
            max_bodies_per_batch: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let (original, wide, _) = receipt_pair(&f, Action::Return, zero_link());
    assert_eq!(
        capped.observe_page(
            &[feed(&f, 1, &[(b"PS2", &original), (b"PSW1", &wide)])],
            &f.scope.program
        ),
        0
    );
    assert!(capped.model.blocked().is_some());
    assert_eq!(capped.resident_selection(), None);
    let mut o = observer(&f, true);
    for n in 0..=MAX_CHAIN_KEYS {
        f.selected.standing = ProvinceKey::new(
            f.selected.standing.world(),
            WideCoord::checked(129 + n as i64, 0).unwrap(),
        );
        f.keys = ReadPlan::new(&f.scope, f.selected).unwrap();
        let (original, wide, _) = receipt_pair(&f, Action::Return, zero_link());
        let applied = o.observe_page(
            &[feed(
                &f,
                n as u64 + 1,
                &[(b"PS2", &original), (b"PSW1", &wide)],
            )],
            &f.scope.program,
        );
        assert_eq!(applied, usize::from(n < MAX_CHAIN_KEYS), "{}", o.status());
    }
    assert!(o.model.blocked().is_some());
    assert_eq!(
        o.status()["resident_receipts"]["transactions"],
        MAX_CHAIN_KEYS
    );
    assert_eq!(o.status()["chain"]["keys"], MAX_CHAIN_KEYS);
    assert_ne!(o.resident_selection(), Some(f.selected));
}

#[test]
fn snapshot_metadata_copied_to_different_account_bytes_is_not_coherent() {
    let f = Fixture::new();
    let original = snapshot(&f).reads();
    let mut edited = f.reads.clone();
    edited.snapshot = original.snapshot.clone();
    edited
        .accounts
        .get_mut(&f.keys.holding())
        .unwrap()
        .as_mut()
        .unwrap()
        .lamports += 1;
    assert_eq!(
        plan(&f.scope, f.selected, &edited).unwrap().context_slot,
        None
    );
    let mut edited = original;
    edited.min_slot += 1;
    assert_eq!(
        plan(&f.scope, f.selected, &edited).unwrap().context_slot,
        None
    );
}
