//! The read-only wide observation model over literal `PSW1` (0x82) bodies
//! and literal feed `TxRecord`s. No key generation, no signing, no
//! transaction, no network, no program execution, no chain verification:
//! the bodies are built with the ABI's own encoder from literal identities
//! and literal link bytes, the transaction logs are literal strings, and
//! the model is exercised in memory. Run with
//! `cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_discovery`.
#![cfg(feature = "wide-world-experimental")]

use base64::Engine as _;
use fclient::ports::{Signature, TxRecord};
use frontier_abi::world_index::event::{
    self as wev, encode, WideEntity, WideKind, WideLink, WIDE_EVENT_VERSION,
};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use keeper_core::wideindex::{
    observe_tx, Limits, Presence, Refusal, Scope, TxObservation, WideAccount, WideBatch,
    WideDiscovery, WideObserver,
};
use solana_address::Address;

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}
fn other_world() -> WorldId {
    WorldId::new([0x78; 32]).unwrap()
}
fn key(w: WorldId, p: i64, q: i64) -> ProvinceKey {
    ProvinceKey::new(w, WideCoord::checked(p, q).unwrap())
}
fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn scope() -> Scope {
    Scope {
        program: program(),
        season: Address::new_from_array([24; 32]),
        world: world(),
        source: "test: literal bodies, caller-authenticated by construction".into(),
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
/// A province-and-holding-linked body (the literal links are not verified
/// by the model; the typed reader does that).
fn both(kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(
        kind,
        bell,
        key,
        payload,
        &[link(WideEntity::Province, 1), link(WideEntity::Holding, 1)],
    )
    .unwrap()
}
fn province_only(kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(kind, bell, key, payload, &[link(WideEntity::Province, 1)]).unwrap()
}
fn unlinked(kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(kind, bell, key, payload, &[]).unwrap()
}
fn batch(seq: u64, bodies: Vec<Vec<u8>>) -> WideBatch {
    WideBatch {
        seq,
        slot: 1_000 + seq,
        signature: format!("sig-{seq}"),
        bodies,
    }
}

/// The identities of one march: home `(129, 0)` site 3, host sequence 7,
/// destination `(129, -1)`.
struct March {
    home: ProvinceKey,
    dest: ProvinceKey,
    host: WideHostRef,
}
fn march() -> March {
    let home = key(world(), 129, 0);
    March {
        home,
        dest: key(world(), 129, -1),
        host: WideHostRef::new(home, 3, 1, 7).unwrap(),
    }
}
fn departed(m: &March, slot: u8, depart: u32, arrive: u32, root: u8) -> Vec<u8> {
    both(
        WideKind::Departed,
        depart,
        &wev::host_key(&m.host, m.home),
        &wev::departed_payload(
            slot,
            depart,
            arrive,
            300_000,
            61,
            5_000,
            7_000,
            11_000,
            &[root; 32],
        ),
    )
}
fn revealed(m: &March, slot: u8, faction: u8, i: u8, displaced: bool) -> Vec<u8> {
    unlinked(
        WideKind::Revealed,
        8,
        &wev::host_key(&m.host, m.dest),
        &wev::revealed_payload(slot, faction, i, 33, 0, 0, 300_000, displaced),
    )
}
fn gathered(m: &March, bell: u32) -> Vec<u8> {
    unlinked(
        WideKind::Gathered,
        22,
        &m.dest.to_bytes(),
        &wev::gathered_payload(bell, 0, 24, 0x00FF_FFFF, 1, false),
    )
}
fn record_closed(m: &March, what: u8, bell: u32, faction: u8, i: u8, lamports: u64) -> Vec<u8> {
    unlinked(
        WideKind::RecordClosed,
        0,
        &m.dest.to_bytes(),
        &wev::record_closed_payload(what, bell, faction, i, &[0xd5; 32], lamports),
    )
}

// ------------------------------------------------------------ feed records

fn data_line(tag: &[u8], body: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b64.encode(tag), b64.encode(body))
}
fn tx(seq: u64, logs: Vec<String>, err: Option<&str>) -> TxRecord {
    TxRecord {
        seq,
        slot: 10 + seq,
        signature: Signature::from([seq as u8; 64]),
        block_time: 0,
        tx: vec![],
        logs,
        err: err.map(str::to_owned),
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
fn wide_tx(seq: u64, bodies: &[Vec<u8>]) -> TxRecord {
    let lines = bodies.iter().map(|b| data_line(b"PSW1", b));
    tx(seq, fclient::log::in_frame(&program(), lines), None)
}

// ------------------------------------------------------------ tests

#[test]
fn batches_apply_atomically_and_index_full_identities_only() {
    let m = march();
    let mut d = model();
    assert_eq!(d.cursor(), None);
    let c0 = d.coverage();
    assert!(!c0.source_complete && !c0.automatic_writes);
    // Muster at home (the alias in the payload is never read into state).
    let muster = both(
        WideKind::Muster,
        4,
        &wev::host_key(&m.host, m.home),
        &wev::muster_payload(0, 300, 17, 0, 0xDEAD_BEEF_0000_0001),
    );
    let a = d.apply(&batch(10, vec![muster])).unwrap();
    assert_eq!((a.seq, a.records, a.replay), (10, 1, false));
    assert_eq!(a.provinces.into_iter().collect::<Vec<_>>(), vec![m.home]);
    assert_eq!(a.hosts.into_iter().collect::<Vec<_>>(), vec![m.host]);
    let h = &d.hosts[&m.host];
    assert_eq!(h.presence, Presence::Mustered { bell: 4, entry: 0 });
    assert_eq!(h.standing, m.home);
    assert!(h.transit.is_none());
    assert!(d.holdings[&m.host.holding_ref()].hosts.contains(&m.host));
    assert_eq!(
        m.host.holding_ref().seq(),
        0,
        "the holding by reference, sequence 0"
    );
    // Depart (bell 6 → 20) and the origin's resolve, one batch.
    let resolve6 = province_only(
        WideKind::Resolve,
        6,
        &m.home.to_bytes(),
        &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true),
    );
    let a = d
        .apply(&batch(11, vec![departed(&m, 0, 6, 20, 0xAB), resolve6]))
        .unwrap();
    assert_eq!(a.records, 2);
    let t = d.hosts[&m.host].transit.as_ref().unwrap();
    assert_eq!(t.slot, 0);
    let dep = t.departure.unwrap();
    assert_eq!(
        (
            dep.origin,
            dep.depart_bell,
            dep.arrive_bell,
            dep.dep_mass_milli
        ),
        (m.home, 6, 20, 300_000)
    );
    assert_eq!(
        (dep.tip, dep.fee, dep.bond, dep.seal_root),
        (5_000, 7_000, 11_000, [0xAB; 32])
    );
    assert!(t.open());
    assert_eq!(d.open_transits(m.host.holding_ref()).seen.len(), 1);
    assert!(d.provinces[&m.home].resolved_bells.contains(&6));
    // Departure settled at the origin, the reveal at the destination (its
    // own bell is the log bell 8; the slot is keyed by the march's arrival
    // bell 20 from the departure), the gather and the resolve of bell 20.
    let dsettled = both(
        WideKind::DepartureSettled,
        8,
        &wev::host_key(&m.host, m.home),
        &wev::departure_settled_payload(0, false, 300_000, 46, 0, 0),
    );
    let resolve20 = province_only(
        WideKind::Resolve,
        20,
        &m.dest.to_bytes(),
        &wev::resolve_payload(&[3; 32], &[4; 32], 0, 0, 0, true),
    );
    d.apply(&batch(12, vec![dsettled, revealed(&m, 0, 2, 0, false)]))
        .unwrap();
    d.apply(&batch(13, vec![gathered(&m, 20), resolve20]))
        .unwrap();
    let t = d.hosts[&m.host].transit.as_ref().unwrap();
    assert_eq!(t.departure_settled.unwrap().troops_after_milli, 300_000);
    let r = t.reveal.unwrap();
    assert_eq!(
        (r.dest, r.arrive_bell, r.faction, r.i, r.tile),
        (m.dest, Some(20), 2, 0, 33)
    );
    assert_eq!(
        r.logged_bell, 8,
        "the record's bell is the log bell, kept apart"
    );
    assert_eq!(d.slots[&(m.dest, 20, 2, 0)].host, Some(m.host));
    assert!(d.days[&(m.dest, 0)].bells_seen.contains(&20));
    assert_eq!(
        d.hosts[&m.host].standing, m.dest,
        "attributed where it happened"
    );
    let g = &d.inputs[&(m.dest, 20)];
    assert_eq!(
        (g.gathers, g.arrivals_mask, g.n_present, g.no_arrivals),
        (1, 0x00FF_FFFF, 1, false)
    );
    assert!(d.provinces[&m.dest].resolved_bells.contains(&20));
    assert!(d.anomalies.is_empty(), "a complete sequence of stages");
    // The settlement, attributed to the destination, the sealed destination
    // kept.
    let settled = both(
        WideKind::TransitSettled,
        23,
        &wev::host_key(&m.host, m.dest),
        &wev::transit_settled_payload(0, 1, 0, 300_000, 5_000, 7_000, 11_000, false, m.dest),
    );
    d.apply(&batch(14, vec![settled])).unwrap();
    let t = d.hosts[&m.host].transit.as_ref().unwrap();
    let s = t.settled.unwrap();
    assert_eq!(
        (s.judged_at, s.sealed_dest, s.outcome, s.seal_code),
        (m.dest, m.dest, 1, 0)
    );
    assert_eq!(
        (s.tip, s.fee, s.bond, s.home_credited),
        (5_000, 7_000, 11_000, false)
    );
    assert!(!t.open());
    assert!(d.open_transits(m.host.holding_ref()).seen.is_empty());
    let c = d.coverage();
    assert_eq!((c.batches, c.records, c.fingerprints), (5, 8, 5));
    assert_eq!((c.first_seq, c.last_seq), (Some(10), Some(14)));
    assert!(!c.source_complete && !c.automatic_writes && c.horizon.is_none());
}

#[test]
fn identical_replay_is_idempotent_and_any_other_replay_blocks() {
    let m = march();
    let muster = both(
        WideKind::Muster,
        4,
        &wev::host_key(&m.host, m.home),
        &wev::muster_payload(0, 300, 17, 0, 1),
    );
    // Identical content at a known sequence: a no-op, nothing counted.
    let mut d = model();
    d.apply(&batch(10, vec![muster.clone()])).unwrap();
    let before = d.coverage();
    let a = d.apply(&batch(10, vec![muster.clone()])).unwrap();
    assert!(a.replay && a.records == 0 && a.provinces.is_empty());
    assert_eq!(d.coverage(), before);
    assert!(d.blocked().is_none());
    assert_eq!(d.apply(&batch(11, vec![])), Err(Refusal::Empty { seq: 11 }));
    assert!(d.blocked().is_none(), "an empty batch is not a blocker");
    assert!(d.apply(&batch(11, vec![muster.clone()])).is_ok());
    // The same sequence with another signature: the source contradicts
    // itself; blocked for good, nothing applied.
    let mut d = model();
    d.apply(&batch(10, vec![muster.clone()])).unwrap();
    let mut other_sig = batch(10, vec![muster.clone()]);
    other_sig.signature = "sig-x".into();
    assert_eq!(
        d.apply(&other_sig),
        Err(Refusal::ReplayConflict { seq: 10 })
    );
    assert_eq!(d.blocked().unwrap().seq, 10);
    assert!(matches!(
        d.apply(&batch(11, vec![muster.clone()])),
        Err(Refusal::Blocked { since_seq: 10, .. })
    ));
    // The same sequence and signature with other bodies: blocked too.
    let mut d = model();
    d.apply(&batch(10, vec![muster.clone()])).unwrap();
    let other_body = both(
        WideKind::Muster,
        5,
        &wev::host_key(&m.host, m.home),
        &wev::muster_payload(0, 300, 17, 0, 1),
    );
    assert_eq!(
        d.apply(&batch(10, vec![other_body])),
        Err(Refusal::ReplayConflict { seq: 10 })
    );
    // An older sequence never applied (before the first batch): unknown,
    // blocked rather than trusted.
    let mut d = model();
    d.apply(&batch(10, vec![muster.clone()])).unwrap();
    assert_eq!(
        d.apply(&batch(9, vec![muster.clone()])),
        Err(Refusal::ReplayUnknown { seq: 9, cursor: 10 })
    );
    assert!(d.blocked().is_some());
    // A sequence the fingerprint window forgot: unknown, blocked.
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_fingerprints: 2,
            ..Limits::default()
        },
    );
    for seq in 10..=12 {
        d.apply(&batch(seq, vec![muster.clone()])).unwrap();
    }
    assert_eq!(d.coverage().fingerprints, 2);
    assert!(d.apply(&batch(12, vec![muster.clone()])).unwrap().replay);
    assert_eq!(
        d.apply(&batch(10, vec![muster.clone()])),
        Err(Refusal::ReplayUnknown {
            seq: 10,
            cursor: 12
        })
    );
    assert!(d.blocked().is_some());
    assert_eq!(d.cursor(), Some(12), "the cursor and the history stay");
}

#[test]
fn wrong_world_version_and_malformed_bodies_refuse_the_whole_batch_and_block() {
    let m = march();
    let good = both(
        WideKind::Muster,
        4,
        &wev::host_key(&m.host, m.home),
        &wev::muster_payload(0, 300, 17, 0, 1),
    );
    // Another world's key, valid in every other respect.
    {
        let mut d = model();
        let foreign_home = key(other_world(), 129, 0);
        let foreign_host = WideHostRef::new(foreign_home, 3, 1, 7).unwrap();
        let foreign = both(
            WideKind::Muster,
            4,
            &wev::host_key(&foreign_host, foreign_home),
            &wev::muster_payload(0, 300, 17, 0, 1),
        );
        assert_eq!(
            d.apply(&batch(10, vec![good.clone(), foreign])),
            Err(Refusal::WrongWorld {
                seq: 10,
                body: 1,
                found: [0x78; 32]
            })
        );
        assert!(
            d.hosts.is_empty() && d.provinces.is_empty(),
            "atomic: the good body is not applied"
        );
        assert_eq!(d.cursor(), None);
        let b = d.blocked().unwrap();
        assert_eq!(
            (b.seq, b.body, b.signature.as_str()),
            (10, Some(1), "sig-10")
        );
        assert!(matches!(
            d.apply(&batch(11, vec![good.clone()])),
            Err(Refusal::Blocked { since_seq: 10, .. })
        ));
        assert!(d.reveals_at(m.dest, 20).blocked);
    }
    // The retired version 0x81 and an unknown version.
    for ver in [0x81u8, 0x83] {
        let mut d = model();
        let mut bad = good.clone();
        bad[0] = ver;
        match d.apply(&batch(10, vec![bad, good.clone()])) {
            Err(Refusal::Version { seq, body, error }) => {
                assert_eq!((seq, body), (10, 0));
                assert!(matches!(
                    error,
                    wev::EventError::RetiredVersion(0x81) | wev::EventError::Version(0x83)
                ));
            }
            other => panic!("expected a version refusal, got {other:?}"),
        }
        assert!(d.blocked().is_some() && d.hosts.is_empty());
    }
    // A truncated body.
    {
        let mut d = model();
        let mut short = good.clone();
        short.truncate(good.len() - 1);
        assert!(matches!(
            d.apply(&batch(10, vec![short])),
            Err(Refusal::Malformed {
                seq: 10,
                body: 0,
                ..
            })
        ));
        assert!(d.blocked().is_some());
    }
    assert_eq!(good[0], WIDE_EVENT_VERSION, "the good body is 0x82");
}

#[test]
fn input_and_state_caps_refuse_before_applying_and_block() {
    let m = march();
    let good = both(
        WideKind::Muster,
        4,
        &wev::host_key(&m.host, m.home),
        &wev::muster_payload(0, 300, 17, 0, 1),
    );
    // Bodies per batch.
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_bodies_per_batch: 1,
            ..Limits::default()
        },
    );
    assert_eq!(
        d.apply(&batch(10, vec![good.clone(), good.clone()])),
        Err(Refusal::Limit {
            seq: 10,
            what: "bodies per batch",
            limit: 1,
            needed: 2
        })
    );
    assert!(d.blocked().is_some() && d.hosts.is_empty() && d.cursor().is_none());
    // Bytes of one body.
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_body_bytes: good.len() - 1,
            ..Limits::default()
        },
    );
    assert!(matches!(
        d.apply(&batch(10, vec![good.clone()])),
        Err(Refusal::Limit {
            what: "bytes of one body",
            ..
        })
    ));
    assert!(d.blocked().is_some());
    // A state cap, checked on the staged copy: a second host over
    // `max_hosts = 1` refuses the whole batch and leaves the first host,
    // the cursor and the fingerprints exactly as they were.
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_hosts: 1,
            ..Limits::default()
        },
    );
    d.apply(&batch(10, vec![good.clone()])).unwrap();
    let before = (d.coverage(), d.hosts.clone(), d.provinces.clone());
    let host2 = WideHostRef::new(m.home, 3, 1, 8).unwrap();
    let second = both(
        WideKind::Muster,
        4,
        &wev::host_key(&host2, m.home),
        &wev::muster_payload(0, 300, 17, 1, 2),
    );
    let resolve = province_only(
        WideKind::Resolve,
        5,
        &m.home.to_bytes(),
        &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true),
    );
    assert_eq!(
        d.apply(&batch(11, vec![resolve, second])),
        Err(Refusal::Limit {
            seq: 11,
            what: "hosts",
            limit: 1,
            needed: 2
        })
    );
    let after = (d.coverage(), d.hosts.clone(), d.provinces.clone());
    assert_eq!(after.1, before.1);
    assert_eq!(
        after.2, before.2,
        "the resolve of the same batch is not applied either"
    );
    assert_eq!(after.0.last_seq, before.0.last_seq);
    assert_eq!(after.0.fingerprints, before.0.fingerprints);
    assert_eq!(after.0.blocked.as_ref().map(|b| b.seq), Some(11));
    // Superseded marches per host.
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_superseded_per_host: 1,
            ..Limits::default()
        },
    );
    d.apply(&batch(10, vec![departed(&m, 0, 6, 20, 1)]))
        .unwrap();
    d.apply(&batch(11, vec![departed(&m, 1, 7, 21, 2)]))
        .unwrap();
    assert_eq!(d.hosts[&m.host].superseded.len(), 1);
    assert!(matches!(
        d.apply(&batch(12, vec![departed(&m, 2, 8, 22, 3)])),
        Err(Refusal::Limit {
            what: "superseded marches of one host",
            ..
        })
    ));
    assert_eq!(
        d.hosts[&m.host].transit.as_ref().unwrap().slot,
        1,
        "unchanged"
    );
    assert!(d.blocked().is_some());
    // The default caps are the conservative ones.
    let l = Limits::default();
    assert!(l.max_bodies_per_batch <= 64 && l.max_fingerprints <= 4_096);
}

#[test]
fn observations_are_never_authoritative_and_the_horizon_claims_nothing() {
    let m = march();
    let mut d = model();
    d.apply(&batch(10, vec![departed(&m, 0, 6, 20, 0xAB)]))
        .unwrap();
    let o = d.reveals_at(m.dest, 20);
    assert!(o.seen.is_empty(), "none observed");
    assert_eq!(
        (o.observed_through, o.horizon, o.source_complete, o.blocked),
        (Some(10), None, false, false)
    );
    // The horizon is an observation about the feed, recorded verbatim; it
    // changes no answer's authority.
    d.observe_horizon(10, "test: an empty feed page after sequence 10")
        .unwrap();
    let o = d.reveals_at(m.dest, 20);
    assert_eq!((o.horizon, o.source_complete), (Some(10), false));
    assert!(o.seen.is_empty());
    let c = d.coverage();
    assert_eq!(c.horizon.as_ref().map(|h| h.through_seq), Some(10));
    assert!(!c.source_complete && !c.automatic_writes);
    assert_eq!(
        d.observe_horizon(5, "test"),
        Err(Refusal::HorizonBehind {
            through_seq: 5,
            cursor: 10
        })
    );
    // A departure alone names no destination (the sealed one is inside the
    // seal): the plan reads the origin, the holding and the open record —
    // nothing of the destination, which the model does not know.
    let plan = d.read_plan();
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::Province(m.home)));
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::Holding(m.host.holding_ref())));
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::Transit(m.host.holding_ref(), 0)));
    assert!(!plan
        .iter()
        .any(|r| matches!(r.account, WideAccount::ArrivalDay(k, _) if k == m.dest)));
    // After the reveal the plan asks for the destination's day and slot;
    // the observation lists the slot, still not authoritatively.
    d.apply(&batch(11, vec![revealed(&m, 0, 2, 0, false)]))
        .unwrap();
    let o = d.reveals_at(m.dest, 20);
    assert_eq!(o.seen.len(), 1);
    assert_eq!(o.seen[0].host, Some(m.host));
    assert_eq!(
        (o.observed_through, o.horizon, o.source_complete),
        (Some(11), Some(10), false)
    );
    let plan = d.read_plan();
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::ArrivalDay(m.dest, 0)));
    assert!(plan
        .iter()
        .any(|r| r.account == WideAccount::ArrivalSlot(m.dest, 20, 2, 0)));
}

#[test]
fn stages_without_their_departure_are_kept_as_anomalies_not_inferred() {
    let m = march();
    let mut d = model();
    // A reveal whose departure is not in the applied history: the arrival
    // bell is unknown, so the slot is not indexed, and the model says so.
    d.apply(&batch(10, vec![revealed(&m, 1, 2, 0, false)]))
        .unwrap();
    let t = d.hosts[&m.host].transit.as_ref().unwrap();
    assert_eq!(t.slot, 1);
    assert!(t.departure.is_none());
    assert_eq!(t.reveal.unwrap().arrive_bell, None);
    assert!(
        d.slots.is_empty(),
        "no arrival bell: no slot key is invented"
    );
    assert_eq!(d.anomalies.len(), 2);
    assert!(d.anomalies.iter().all(|a| a.host == Some(m.host)));
    // A second departure while the first march is open in the applied
    // history: applied (the chain is authoritative), the old march kept as
    // superseded, an anomaly recorded.
    d.apply(&batch(11, vec![departed(&m, 1, 6, 20, 1)]))
        .unwrap();
    d.apply(&batch(12, vec![departed(&m, 2, 30, 44, 2)]))
        .unwrap();
    let h = &d.hosts[&m.host];
    assert_eq!(h.transit.as_ref().unwrap().slot, 2);
    assert_eq!(h.superseded.len(), 2);
    assert!(d
        .anomalies
        .iter()
        .any(|a| a.seq == 12 && a.what.starts_with("a departure while")));
    // The settlement inputs: what the records give, what they cannot.
    let si = d.settlement_inputs(m.host).unwrap();
    assert_eq!(si.transit_slot, 2);
    assert!(si.have.iter().any(|s| s.contains("seal root")));
    assert!(si.missing.iter().any(|s| s.contains("commitment")));
    assert!(si.missing.iter().any(|s| s.contains("sealed body")));
    assert!(si.missing.iter().any(|s| s.contains("round-T")));
    assert!(si.missing.iter().any(|s| s.contains("destination")));
}

#[test]
fn close_only_slots_days_and_inputs_keep_exact_identity_and_rent_and_are_planned() {
    let m = march();
    let mut d = model();
    // No reveal, no gather in the applied history: the closes alone.
    d.apply(&batch(
        10,
        vec![
            record_closed(&m, 2, 20, 2, 1, 1_000),
            record_closed(&m, 3, 150, 0, 0, 2_000),
            record_closed(&m, 4, 20, 0, 0, 3_000),
        ],
    ))
    .unwrap();
    let s = &d.slots[&(m.dest, 20, 2, 1)];
    assert_eq!((s.host, s.transit_slot, s.reveal), (None, None, None));
    assert_eq!(
        (s.closed.unwrap().lamports, s.closed.unwrap().rent_to),
        (1_000, [0xd5; 32])
    );
    let day = &d.days[&(m.dest, 1)];
    assert!(day.bells_seen.is_empty());
    assert_eq!(day.closed.unwrap().lamports, 2_000);
    let g = &d.inputs[&(m.dest, 20)];
    assert_eq!((g.gathers, g.closed.unwrap().lamports), (0, 3_000));
    assert_eq!(
        d.anomalies.len(),
        3,
        "each close without its prior record is noted"
    );
    let plan = d.read_plan();
    for want in [
        WideAccount::ArrivalSlot(m.dest, 20, 2, 1),
        WideAccount::ArrivalDay(m.dest, 1),
        WideAccount::ClashInputs(m.dest, 20),
        WideAccount::Province(m.dest),
    ] {
        assert!(plan.iter().any(|r| r.account == want), "{want:?}");
    }
    assert!(plan
        .iter()
        .filter(|r| matches!(
            r.account,
            WideAccount::ArrivalSlot(..)
                | WideAccount::ArrivalDay(..)
                | WideAccount::ClashInputs(..)
        ))
        .all(|r| r.why.contains("confirm the account is gone")));
    // The observation lists the closed slot (as a close, not a reveal).
    let o = d.reveals_at(m.dest, 20);
    assert_eq!(o.seen.len(), 1);
    assert!(o.seen[0].reveal.is_none() && o.seen[0].closed.is_some());
}

#[test]
fn activity_after_a_close_never_overwrites_the_close() {
    let m = march();
    let mut d = model();
    d.apply(&batch(
        10,
        vec![
            departed(&m, 0, 6, 20, 0xAB),
            revealed(&m, 0, 2, 0, false),
            gathered(&m, 20),
        ],
    ))
    .unwrap();
    let province_close = province_only(
        WideKind::ProvinceClosed,
        0,
        &m.dest.to_bytes(),
        &wev::province_closed_payload(&[0x99; 32], 6_000),
    );
    d.apply(&batch(
        11,
        vec![
            record_closed(&m, 2, 20, 2, 0, 1_000),
            record_closed(&m, 4, 20, 0, 0, 3_000),
            province_close.clone(),
        ],
    ))
    .unwrap();
    assert!(d.anomalies.is_empty());
    let first_slot = d.slots[&(m.dest, 20, 2, 0)].closed.unwrap();
    let first_inputs = d.inputs[&(m.dest, 20)].closed.unwrap();
    let first_prov = d.provinces[&m.dest].closed.unwrap();
    // Later: a reveal into the closed slot, a gather into the closed
    // inputs, a second close of each, a resolve attributed to the closed
    // province. Every first close stays; the activity is counted and noted.
    let resolve = province_only(
        WideKind::Resolve,
        21,
        &m.dest.to_bytes(),
        &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true),
    );
    d.apply(&batch(
        12,
        vec![
            revealed(&m, 0, 2, 0, true),
            gathered(&m, 20),
            record_closed(&m, 2, 20, 2, 0, 9_999),
            record_closed(&m, 4, 20, 0, 0, 9_999),
            province_close,
            resolve,
        ],
    ))
    .unwrap();
    let s = &d.slots[&(m.dest, 20, 2, 0)];
    assert_eq!(s.closed.unwrap(), first_slot);
    assert_eq!(s.after_close, 2);
    assert!(!s.reveal.unwrap().displaced, "the earlier reveal stays");
    let g = &d.inputs[&(m.dest, 20)];
    assert_eq!(g.closed.unwrap(), first_inputs);
    assert_eq!((g.gathers, g.after_close), (1, 2));
    let p = &d.provinces[&m.dest];
    assert_eq!(p.closed.unwrap(), first_prov);
    assert!(
        p.after_close >= 6,
        "every record attributed after the close is counted"
    );
    assert!(
        p.resolved_bells.contains(&21),
        "the record's own fact is kept beside the ambiguity"
    );
    assert!(d
        .anomalies
        .iter()
        .any(|a| a.what.contains("after its close")));
    assert!(d
        .anomalies
        .iter()
        .any(|a| a.what.contains("second slot close")));
    assert!(d
        .anomalies
        .iter()
        .any(|a| a.what.contains("second province close")));
    assert_eq!(d.blocked(), None, "preserved ambiguity, not a blocker");
    // A stage of a settled march.
    let settled = both(
        WideKind::TransitSettled,
        23,
        &wev::host_key(&m.host, m.dest),
        &wev::transit_settled_payload(0, 1, 0, 300_000, 5_000, 7_000, 11_000, false, m.dest),
    );
    d.apply(&batch(13, vec![settled])).unwrap();
    let before = d.hosts[&m.host].transit.clone().unwrap();
    let late = both(
        WideKind::DepartureSettled,
        30,
        &wev::host_key(&m.host, m.home),
        &wev::departure_settled_payload(0, false, 1, 1, 1, 0),
    );
    d.apply(&batch(14, vec![late])).unwrap();
    let t = d.hosts[&m.host].transit.as_ref().unwrap();
    assert_eq!(t.settled, before.settled);
    assert_eq!(
        t.departure_settled, before.departure_settled,
        "the earlier stage stays"
    );
    assert_eq!(t.after_close, 1);
}

#[test]
fn feed_transactions_are_frame_checked_and_rollbacks_are_never_wide_events() {
    let m = march();
    let p = program();
    let body = departed(&m, 0, 6, 20, 0xAB);
    // A committed PSW1 body in the program's frame.
    match observe_tx(&wide_tx(3, std::slice::from_ref(&body)), &p).unwrap() {
        TxObservation::Wide(b) => {
            assert_eq!((b.seq, b.slot, b.bodies.len()), (3, 13, 1));
            assert_eq!(b.signature, Signature::from([3u8; 64]).to_string());
            assert_eq!(b.bodies[0], body);
        }
        other => panic!("{other:?}"),
    }
    // A failed transaction: rolled back, never a wide event.
    let failed = tx(
        4,
        fclient::log::in_frame(&p, [data_line(b"PSW1", &body)]),
        Some("custom program error: 0x7"),
    );
    assert_eq!(observe_tx(&failed, &p).unwrap(), TxObservation::RolledBack);
    // A failed CPI subtree inside a successful outer transaction: the
    // program's PSW1 body is in the rolled-back frame and is dropped; the
    // transaction is legacy-only to the observer.
    let outer = Address::new_from_array([25; 32]);
    let logs = vec![
        format!("Program {outer} invoke [1]"),
        format!("Program {p} invoke [2]"),
        data_line(b"PSW1", &body),
        format!("Program {p} failed: custom program error: 0x1"),
        format!("Program {outer} success"),
    ];
    assert_eq!(
        observe_tx(&tx(5, logs, None), &p).unwrap(),
        TxObservation::Legacy
    );
    // Another program's PSW1-shaped data in its own frame is not ours.
    let logs = fclient::log::in_frame(&outer, [data_line(b"PSW1", &body)]);
    assert!(matches!(
        observe_tx(&tx(6, logs, None), &p),
        Err(fclient::typed_log::DecodeError::MissingProgramFrame)
    ));
    // The observer over pages: counts, the model, the status.
    let mut o = WideObserver::new(scope(), Limits::default());
    let legacy_ps2 = {
        use frontier_abi::log::{self as plog, Kind};
        let mut key = 1i32.to_le_bytes().to_vec();
        key.extend(2i32.to_le_bytes());
        let mut b = vec![0; 512];
        let n = plog::write_body(
            Kind::PROVINCE_OPEN,
            3,
            &key,
            &vec![0; Kind::PROVINCE_OPEN.spec().payload_len()],
            &mut b,
        )
        .unwrap();
        b.truncate(n);
        b.push(0);
        tx(1, fclient::log::in_frame(&p, [data_line(b"PS2", &b)]), None)
    };
    assert_eq!(
        o.observe_page(&[], &p),
        0,
        "an empty page: nothing, no claim"
    );
    assert_eq!(o.last_seq_seen, None);
    let page = vec![
        legacy_ps2,
        tx(
            2,
            fclient::log::in_frame(&p, [data_line(b"PSW1", &body)]),
            Some("err"),
        ),
        wide_tx(3, std::slice::from_ref(&body)),
    ];
    assert_eq!(o.observe_page(&page, &p), 1);
    assert_eq!((o.legacy_txs, o.rolled_back_txs, o.wide_txs), (1, 1, 1));
    assert_eq!(o.model.cursor(), Some(3));
    assert!(o.model.hosts.contains_key(&m.host));
    // The same page again (an overlap after a restart of the pull):
    // fingerprint-checked, with no state changes or double-counting.
    assert_eq!(o.observe_page(&page, &p), 0);
    assert_eq!((o.legacy_txs, o.rolled_back_txs, o.wide_txs), (1, 1, 1));
    // A gap, then a reader refusal (truncated logs) blocks the model.
    let mut truncated = wide_tx(7, std::slice::from_ref(&body));
    truncated.logs.push("Log truncated".into());
    assert_eq!(o.observe_page(&[truncated], &p), 0);
    assert_eq!((o.gaps, o.decode_failures), (1, 1));
    let b = o.model.blocked().unwrap();
    assert_eq!((b.seq, b.body), (7, None));
    assert!(b.reason.contains("Truncated"));
    assert_eq!(
        o.observe_page(&[wide_tx(8, &[body])], &p),
        0,
        "blocked: nothing applied"
    );
    let st = o.status();
    assert_eq!(st["automatic_writes"], false);
    assert_eq!(st["source_complete"], false);
    assert_eq!(st["wide_txs"], 1);
    assert_eq!(st["rolled_back_txs"], 1);
    assert_eq!(st["blocker"]["seq"], 7);
    assert_eq!(st["hosts"], 1);
}

#[test]
fn observer_exact_replay_covers_every_transaction_outcome() {
    let records = [
        tx(
            1,
            fclient::log::in_frame(&program(), Vec::<String>::new()),
            None,
        ),
        tx(1, vec![], Some("rollback")),
        wide_tx(1, &[departed(&march(), 0, 6, 20, 1)]),
    ];
    for record in records {
        let mut o = WideObserver::new(scope(), Limits::default());
        o.observe_page(std::slice::from_ref(&record), &program());
        assert!(o.model.blocked().is_none());
        let before = o.status();
        o.observe_page(std::slice::from_ref(&record), &program());
        assert_eq!(o.status(), before, "exact overlap mutates nothing");
        let mut changed = record.clone();
        changed.fee = 1; // Non-log fields must also be fingerprinted.
        o.observe_page(&[changed], &program());
        assert!(o.model.blocked().unwrap().reason.contains("conflicting"));
        assert_eq!(o.last_seq_seen, Some(1));
        let blocked = o.status();
        o.observe_page(&[record], &program());
        assert_eq!(o.status(), blocked, "sticky");
    }
    let mut o = WideObserver::new(scope(), Limits::default());
    let mut record = wide_tx(1, &[departed(&march(), 0, 6, 20, 1)]);
    o.observe_page(std::slice::from_ref(&record), &program());
    record.err = Some("rollback".into());
    o.observe_page(&[record], &program());
    assert!(o.model.blocked().unwrap().reason.contains("conflicting"));
}

#[test]
fn observer_unknown_replay_zero_and_bad_page_order_fail_closed() {
    let legacy = |seq| {
        tx(
            seq,
            fclient::log::in_frame(&program(), Vec::<String>::new()),
            None,
        )
    };
    for limit in [0, 1] {
        let mut o = WideObserver::new(
            scope(),
            Limits {
                max_fingerprints: limit,
                ..Limits::default()
            },
        );
        o.observe_page(&[legacy(1), legacy(2)], &program());
        assert!(o.model.blocked().is_none());
        o.observe_page(&[legacy(1)], &program());
        assert!(o.model.blocked().unwrap().reason.contains("unknown"));
        assert_eq!(o.legacy_txs, 2);
    }
    for page in [
        vec![legacy(0)],
        vec![legacy(2), legacy(1)],
        vec![legacy(1), legacy(1)],
    ] {
        let mut o = WideObserver::new(scope(), Limits::default());
        o.observe_page(&page, &program());
        assert!(o.model.blocked().is_some());
        assert_eq!(o.last_seq_seen, None);
        assert_eq!(o.legacy_txs, 0);
    }
    let mut d = model();
    assert_eq!(
        d.apply(&batch(0, vec![departed(&march(), 0, 6, 20, 1)])),
        Err(Refusal::InvalidSequence { seq: 0 })
    );
    assert!(d.hosts.is_empty() && d.blocked().is_some());
}

#[test]
fn observer_cannot_decode_a_foreign_program_under_its_scope() {
    let foreign = Address::new_from_array([31; 32]);
    let record = tx(
        1,
        fclient::log::in_frame(
            &foreign,
            [data_line(b"PSW1", &departed(&march(), 0, 6, 20, 1))],
        ),
        None,
    );
    let mut o = WideObserver::new(scope(), Limits::default());
    assert_eq!(o.observe_page(&[record], &foreign), 0);
    assert!(o.model.blocked().unwrap().reason.contains("scope"));
    assert!(o.model.hosts.is_empty());
    assert_eq!(o.last_seq_seen, None);
}

#[test]
fn aggregate_nested_caps_are_atomic() {
    let m = march();
    let resolve = |bell| {
        province_only(
            WideKind::Resolve,
            bell,
            &m.home.to_bytes(),
            &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true),
        )
    };
    let mut d = WideDiscovery::new(
        scope(),
        Limits {
            max_nested_entries: 3,
            ..Limits::default()
        },
    );
    d.apply(&batch(1, vec![resolve(1), resolve(2)])).unwrap();
    let before = d.provinces.clone();
    assert_eq!(
        d.apply(&batch(2, vec![resolve(3)])),
        Err(Refusal::Limit {
            seq: 2,
            what: "nested entries",
            limit: 3,
            needed: 4
        })
    );
    assert_eq!(d.provinces, before);
    assert_eq!(d.cursor(), Some(1));
    assert!(d.blocked().is_some());
    // Gather: kind + province bell + day bell. Departure: kind + province
    // host + holding host. All nested entries count, and none are evicted.
    for body in [gathered(&m, 20), departed(&m, 0, 6, 20, 1)] {
        let mut d = WideDiscovery::new(
            scope(),
            Limits {
                max_nested_entries: 2,
                ..Limits::default()
            },
        );
        assert!(matches!(
            d.apply(&batch(1, vec![body])),
            Err(Refusal::Limit {
                what: "nested entries",
                needed: 3,
                ..
            })
        ));
        assert!(
            d.provinces.is_empty()
                && d.days.is_empty()
                && d.inputs.is_empty()
                && d.hosts.is_empty()
                && d.holdings.is_empty()
        );
    }
}

#[test]
fn reveal_and_gather_after_day_close_keep_terminal_evidence() {
    let m = march();
    let mut d = model();
    d.apply(&batch(
        1,
        vec![
            departed(&m, 0, 6, 20, 1),
            record_closed(&m, 3, 20, 0, 0, 2_000),
        ],
    ))
    .unwrap();
    let before = d.days[&(m.dest, 0)].clone();
    d.apply(&batch(
        2,
        vec![revealed(&m, 0, 2, 0, false), gathered(&m, 21)],
    ))
    .unwrap();
    let day = &d.days[&(m.dest, 0)];
    assert_eq!(day.closed, before.closed);
    assert_eq!(day.bells_seen, before.bells_seen);
    assert_eq!(day.after_close, 2);
    assert_eq!(
        d.anomalies
            .iter()
            .filter(|a| a.what.contains("into a closed day"))
            .count(),
        2
    );
    assert!(d.blocked().is_none());
    assert!(!d.coverage().source_complete && !d.coverage().automatic_writes);
}
