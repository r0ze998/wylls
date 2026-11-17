//! The read-only wide observation model over **literal** economy receipt
//! bodies (kinds 15 `Economy` and 16 `EconomyMirror`): no key generation,
//! no signing, no transaction, no network, no program execution, no chain
//! or digest verification. The bodies are built with the ABI's own encoder
//! from literal identities, literal receipts and literal link bytes; the
//! model is exercised in memory. Run with
//! `cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_economy_index`.
#![cfg(feature = "wide-world-experimental")]

use frontier_abi::world_index::event::{
    self as wev, encode, EventError, WideEntity, WideKind, WideLink, HEAD_LEN,
};
use frontier_abi::world_index::{
    EconomyAction, EconomyReceipt, ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use keeper_core::wideduty::{return_candidates, settle_candidates};
use keeper_core::wideindex::{Limits, Refusal, Scope, WideAccount, WideBatch, WideDiscovery};
use solana_address::Address;

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}
fn other_world() -> WorldId {
    WorldId::new([0x78; 32]).unwrap()
}
fn home(w: WorldId) -> ProvinceKey {
    ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap())
}
/// The holding reference: site 3, generation 1, sequence 0.
fn holding(w: WorldId) -> WideHostRef {
    WideHostRef::new(home(w), 3, 1, 0).unwrap()
}
fn scope() -> Scope {
    Scope {
        program: Address::new_from_array([23; 32]),
        season: Address::new_from_array([24; 32]),
        world: world(),
        source: "test: literal economy receipts, caller-authenticated by construction".into(),
    }
}
fn model() -> WideDiscovery {
    WideDiscovery::new(scope(), Limits::default())
}
fn link(entity: WideEntity, seq: u64) -> WideLink {
    WideLink {
        entity,
        seq,
        head: [seq as u8; 32],
    }
}
fn receipt(action: EconomyAction) -> Vec<u8> {
    wev::economy_payload(&EconomyReceipt {
        action,
        now_ts: 1_700_060_000,
        became_final: false,
        input_digest: [0x1A; 32],
        output_digest: [0x0B; 32],
    })
    .unwrap()
    .to_vec()
}
/// A literal record of `action` for `holding` (the links are literal; the
/// model verifies no chain).
fn economy(holding: &WideHostRef, action: EconomyAction) -> Vec<u8> {
    let kind = action.kind();
    let links: Vec<WideLink> = kind.links().iter().map(|e| link(*e, 1)).collect();
    encode(kind, 100, &holding.to_bytes(), &receipt(action), &links).unwrap()
}
fn batch(seq: u64, bodies: Vec<Vec<u8>>) -> WideBatch {
    WideBatch {
        seq,
        slot: 1_000 + seq,
        signature: format!("sig-{seq}"),
        bodies,
    }
}
const WALLS: EconomyAction = EconomyAction::Build { item: 6 };

#[test]
fn both_economy_kinds_are_counted_on_the_holding_and_its_province_and_nothing_else() {
    let h = holding(world());
    let mut d = model();
    let a = d
        .apply(&batch(10, vec![economy(&h, EconomyAction::Harvest)]))
        .unwrap();
    assert_eq!((a.seq, a.records, a.replay), (10, 1, false));
    assert_eq!(
        a.provinces.into_iter().collect::<Vec<_>>(),
        vec![home(world())]
    );
    assert!(a.hosts.is_empty(), "a receipt names no host");
    let a = d.apply(&batch(11, vec![economy(&h, WALLS)])).unwrap();
    assert_eq!(a.records, 1);
    assert!(a.hosts.is_empty());
    // the province: both kinds counted, last sequence stamped
    let p = &d.provinces[&home(world())];
    assert_eq!(p.records.get(&(WideKind::Economy as u8)), Some(&1));
    assert_eq!(p.records.get(&(WideKind::EconomyMirror as u8)), Some(&1));
    assert_eq!(p.last_seq, 11);
    assert!(p.hosts.is_empty(), "no host stood here");
    assert!(p.closed.is_none() && p.roster_closed.is_none());
    // the holding: last sequence only
    let hs = &d.holdings[&h];
    assert_eq!(hs.last_seq, 11);
    assert!(hs.hosts.is_empty(), "no host was issued");
    // no host, no transit, no duty
    assert!(d.hosts.is_empty());
    assert!(d.open_transits(h).seen.is_empty());
    assert!(settle_candidates(&d).is_empty());
    assert!(return_candidates(&d).is_empty());
    assert!(d.anomalies.is_empty());
    let plan = d.read_plan();
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::Province(home(world()))));
    assert!(plan.iter().any(|r| r.account == WideAccount::Holding(h)));
    assert!(
        !plan.iter().any(|r| matches!(
            r.account,
            WideAccount::Transit(..) | WideAccount::Roster(_) | WideAccount::ArrivalSlot(..)
        )),
        "a receipt asks for no march account"
    );
    let c = d.coverage();
    assert_eq!((c.batches, c.records), (2, 2));
    assert!(!c.automatic_writes && !c.source_complete);
    // an exact replay is a no-op
    assert!(
        d.apply(&batch(11, vec![economy(&h, WALLS)]))
            .unwrap()
            .replay
    );
    assert_eq!(d.holdings[&h].last_seq, 11);
}

#[test]
fn a_non_canonical_receipt_or_key_blocks_the_model() {
    let h = holding(world());
    let payload_at = HEAD_LEN + h.to_bytes().len();
    // the receipt version byte
    let mut bad = economy(&h, EconomyAction::Harvest);
    bad[payload_at] = 2;
    let mut d = model();
    assert_eq!(
        d.apply(&batch(1, vec![bad])),
        Err(Refusal::Malformed {
            seq: 1,
            body: 0,
            error: EventError::Payload
        })
    );
    assert!(d.blocked().is_some());
    assert!(d.holdings.is_empty() && d.provinces.is_empty());
    // a walls receipt under the holding-only kind
    let mut bad = economy(&h, EconomyAction::Harvest);
    bad[payload_at + 1..payload_at + 7].copy_from_slice(&[1, 6, 0, 0, 0, 0]);
    let mut d = model();
    assert_eq!(
        d.apply(&batch(1, vec![bad])),
        Err(Refusal::Malformed {
            seq: 1,
            body: 0,
            error: EventError::Payload
        })
    );
    // a host reference (sequence ≠ 0) in the key position
    let mut bad = economy(&h, EconomyAction::Harvest);
    bad[payload_at - 4..payload_at].copy_from_slice(&7u32.to_le_bytes());
    let mut d = model();
    assert_eq!(
        d.apply(&batch(1, vec![bad])),
        Err(Refusal::Malformed {
            seq: 1,
            body: 0,
            error: EventError::Key
        })
    );
    assert!(d.blocked().is_some());
    // a refusal after a good batch applies nothing of the bad one
    let mut d = model();
    d.apply(&batch(1, vec![economy(&h, EconomyAction::Harvest)]))
        .unwrap();
    let mut bad = economy(&h, WALLS);
    bad[payload_at] = 0;
    assert!(d.apply(&batch(2, vec![bad])).is_err());
    assert_eq!(d.holdings[&h].last_seq, 1);
    assert_eq!(d.cursor(), Some(1));
}

#[test]
fn a_receipt_of_another_world_is_refused_and_blocks() {
    let mut d = model();
    let foreign = holding(other_world());
    assert_eq!(
        d.apply(&batch(1, vec![economy(&foreign, EconomyAction::Harvest)])),
        Err(Refusal::WrongWorld {
            seq: 1,
            body: 0,
            found: *other_world().as_bytes()
        })
    );
    assert!(d.blocked().is_some());
    assert!(d.holdings.is_empty() && d.provinces.is_empty() && d.hosts.is_empty());
    // blocked for good: the right world no longer applies
    assert!(matches!(
        d.apply(&batch(2, vec![economy(&holding(world()), WALLS)])),
        Err(Refusal::Blocked { since_seq: 1, .. })
    ));
}
