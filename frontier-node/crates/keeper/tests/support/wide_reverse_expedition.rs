//! Public deterministic storage fixtures; no execution, keys or cryptography.
use super::*;
use frontier_abi::world_index::expedition_reverse_transport::{ReverseMarker, ReverseTransit};
use keeper_core::wideexpedition::{
    plan_with_reverse,
    reverse::{Next as ReverseNext, SCHEMA},
};

fn reverse(f: &mut Fixture) -> ReverseTransit {
    let ctx = AddrCtx {
        program: f.scope.program.to_bytes(),
        season: f.scope.season.to_bytes(),
    };
    let transit = WideTransit::depart(
        march::HOST_IDENTITY_FULL_REF_V1,
        f.selected.host,
        2,
        0,
        TileAddress::new(f.selected.standing, 0).unwrap(),
        9,
        11,
        GENESIS + 5400,
        12345,
        10000,
        10000,
        [5; 32],
        0,
        0,
        a(8).to_bytes(),
    )
    .unwrap();
    let r = ReverseTransit::new(
        &ctx,
        0,
        transit,
        f.selected.original_owner.to_bytes(),
        f.selected.host.key(),
    )
    .unwrap();
    let marker = ReverseMarker::new(&ctx, &r, 3, 0).unwrap();
    f.data(f.keys.holding())[H::transit(0)..H::transit(0) + 96].copy_from_slice(&marker.to_bytes());
    f.reads.accounts.insert(
        f.keys.bridges()[0],
        Some(Account {
            data: r.to_bytes().to_vec(),
            owner: f.scope.program,
            lamports: 100,
            executable: false,
        }),
    );
    r
}

fn expand(f: &mut Fixture) {
    let Err(Refusal::MissingReads(extra)) = plan_with_reverse(&f.scope, f.selected, &f.reads)
    else {
        panic!("must discover reads");
    };
    for key in extra {
        f.reads.accounts.insert(key, None);
    }
}

#[test]
fn strict_reverse_pair_is_opt_in_and_reports_separate_schema() {
    let mut f = Fixture::new();
    reverse(&mut f);
    assert_eq!(
        plan(&f.scope, f.selected, &f.reads),
        Err(Refusal::OwnedBridgeRequired)
    );
    expand(&mut f);
    let report = plan_with_reverse(&f.scope, f.selected, &f.reads).unwrap();
    assert_eq!(report.next, Next::Reverse(ReverseNext::SettleWideOrigin));
    let value = report.describe();
    assert_eq!(value["schema"], SCHEMA);
    for key in [
        "dispatch_available",
        "admitted",
        "signed",
        "enqueued",
        "automatic_send",
        "completion_proven",
    ] {
        assert_eq!(value[key], false);
    }
    f.data(f.keys.bridges()[0])[304] ^= 1;
    assert!(plan_with_reverse(&f.scope, f.selected, &f.reads).is_err());
}

#[test]
fn reverse_generation_requires_actual_capture_metadata() {
    let mut f = Fixture::new();
    reverse(&mut f);
    expand(&mut f);
    f.data(f.keys.holding())[H::GEN] += 1;
    assert_eq!(
        plan_with_reverse(&f.scope, f.selected, &f.reads),
        Err(Refusal::SourceGeneration)
    );
    let tag = frontier_abi::addr::citizen_tag(&f.selected.original_owner.to_bytes());
    let gen = f.selected.host.gen();
    let home = frontier_abi::addr::host_id(127, 0, 1, 2, 0).unwrap();
    let h = f.data(f.keys.holding());
    h[H::CAPTURE_FLAGS] = H::CAPTURE_FLAG_CAPTURED;
    h[H::PREV_GEN] = gen;
    wr_u64(h, H::PREV_OWNER_TAG, tag);
    wr_u64(h, H::PREV_HOME, home);
    expand(&mut f);
    let report = plan_with_reverse(&f.scope, f.selected, &f.reads).unwrap();
    assert_eq!(
        report.next,
        Next::Reverse(ReverseNext::CapturedSourceSettlementEvidence)
    );
    f.data(f.keys.holding())[H::PREV_GEN] ^= 1;
    assert_eq!(
        plan_with_reverse(&f.scope, f.selected, &f.reads),
        Err(Refusal::SourceGeneration)
    );
}

#[test]
fn destroyed_reverse_never_suggests_reveal() {
    let mut f = Fixture::new();
    let r = reverse(&mut f);
    expand(&mut f);
    let ctx = AddrCtx {
        program: f.scope.program.to_bytes(),
        season: f.scope.season.to_bytes(),
    };
    let destroyed = r.settle_origin(&ctx, true, (0, 0, 0)).unwrap();
    *f.data(f.keys.bridges()[0]) = destroyed.to_bytes().to_vec();
    assert_eq!(
        plan_with_reverse(&f.scope, f.selected, &f.reads)
            .unwrap()
            .next,
        Next::Reverse(ReverseNext::OriginDestroyedCleanupEvidence)
    );
}

struct ReverseSource {
    fixture: Fixture,
    calls: AtomicUsize,
    mutate_final: bool,
}
impl SnapshotSource for ReverseSource {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(!rent);
        assert!(call < 2);
        assert_eq!(min_slot, if call == 0 { 80 } else { 100 });
        assert!(keys.len() <= keeper_core::wideexpedition::reverse::MAX_READS);
        Box::pin(async move {
            let f = &self.fixture;
            let mut values: Vec<_> = keys
                .iter()
                .map(|key| {
                    let mut account = f.reads.accounts.get(key).cloned().flatten();
                    if call == 1 && self.mutate_final && *key == f.keys.bridges()[0] {
                        account.as_mut().unwrap().owner = a(99);
                    }
                    account.as_ref().map_or(Value::Null, encoded)
                })
                .collect();
            values.push(encoded(&Account {
                data: f.reads.clock.unwrap().encode().to_vec(),
                owner: sysvar_owner(),
                lamports: 1,
                executable: false,
            }));
            parse_snapshot_response(
                &json!({"context":{"slot":100},"value":values}),
                keys,
                false,
                min_slot,
            )
        })
    }
}

#[tokio::test]
async fn reverse_expands_once_and_rechecks_entire_final_snapshot() {
    for mutate_final in [false, true] {
        let mut fixture = Fixture::new();
        reverse(&mut fixture);
        expand(&mut fixture);
        let source = ReverseSource {
            fixture,
            calls: AtomicUsize::new(0),
            mutate_final,
        };
        let result = inspect(&source, &source.fixture.scope, source.fixture.selected, 80).await;
        if mutate_final {
            assert!(result.is_err());
        } else {
            let report = result.unwrap();
            assert_eq!(report.context_slot, Some(100));
            assert_eq!(report.min_slot, 100);
        }
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    }
}
