//! Pure shared-reader fixtures: no sockets, runtime, keys or transactions.
#![cfg(feature = "snapshot")]

use base64::Engine as _;
use fclient::ports::ClockSysvar;
use fclient::snapshot::{
    parse_snapshot_response, sysvar_owner, RentSysvar, SnapshotError, MAX_SNAPSHOT_KEYS,
};
use serde_json::{json, Value};
use solana_address::Address;

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

fn entry(owner: Address, bytes: &[u8]) -> Value {
    json!({
        "lamports": 5000, "owner": owner.to_string(), "executable": false,
        "data": [base64::engine::general_purpose::STANDARD.encode(bytes), "base64"],
    })
}

fn fixture(with_rent: bool) -> Value {
    let clock = ClockSysvar {
        slot: 123,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 9,
        leader_schedule_epoch: 10,
        unix_timestamp: 1_700_000_042,
    };
    let mut values = vec![
        entry(address(42), &[1, 2, 3]),
        Value::Null,
        entry(sysvar_owner(), &clock.encode()),
    ];
    if with_rent {
        values.push(entry(
            sysvar_owner(),
            &RentSysvar {
                lamports_per_byte_year: 3480,
                exemption_threshold: 2.0,
                burn_percent: 50,
            }
            .encode(),
        ));
    }
    json!({"context": {"slot": 123}, "value": values})
}

#[test]
fn shared_reader_preserves_context_presence_and_sealed_provenance() {
    let keys = [address(11), address(12)];
    for with_rent in [false, true] {
        let snap = parse_snapshot_response(&fixture(with_rent), &keys, with_rent, 100).unwrap();
        assert_eq!(snap.meta().context_slot(), 123);
        assert_eq!(snap.meta().min_slot(), 100);
        assert_eq!(snap.meta().commitment(), "confirmed");
        assert_eq!(snap.meta().keys(), 2);
        assert_eq!(snap.meta().rent_included(), with_rent);
        assert!(snap.accounts()[&keys[1]].is_none());
        assert!(snap.meta().verify(
            100,
            Some(&snap.clock()),
            snap.rent().as_ref(),
            snap.accounts()
        ));
        let mut changed = snap.accounts().clone();
        changed
            .get_mut(&keys[0])
            .unwrap()
            .as_mut()
            .unwrap()
            .data
            .push(4);
        assert!(!snap
            .meta()
            .verify(100, Some(&snap.clock()), snap.rent().as_ref(), &changed));
        assert!(!snap.meta().verify(
            99,
            Some(&snap.clock()),
            snap.rent().as_ref(),
            snap.accounts()
        ));
        assert!(!snap
            .meta()
            .verify(100, None, snap.rent().as_ref(), snap.accounts()));
    }
}

#[test]
fn shared_reader_retains_typed_refusals_and_strict_sysvars() {
    let keys = [address(11), address(12)];
    let good = fixture(true);
    assert_eq!(
        parse_snapshot_response(&good, &[keys[0], keys[0]], true, 100),
        Err(SnapshotError::DuplicateKey)
    );
    assert_eq!(
        parse_snapshot_response(&good, &vec![address(1); MAX_SNAPSHOT_KEYS + 1], true, 100),
        Err(SnapshotError::TooManyKeys { n: 99, max: 98 })
    );
    assert_eq!(
        parse_snapshot_response(&good, &keys, true, 124),
        Err(SnapshotError::Stale {
            context_slot: 123,
            min_slot: 124
        })
    );
    let mut partial = good.clone();
    partial["value"].as_array_mut().unwrap().pop();
    assert_eq!(
        parse_snapshot_response(&partial, &keys, true, 100),
        Err(SnapshotError::Partial { want: 4, got: 3 })
    );
    let mut malformed = good.clone();
    malformed["context"] = json!({});
    assert_eq!(
        parse_snapshot_response(&malformed, &keys, true, 100),
        Err(SnapshotError::Malformed("no context.slot"))
    );
    for (index, expected) in [
        (2, SnapshotError::BadClock("executable")),
        (3, SnapshotError::BadRent("executable")),
    ] {
        let mut invalid = good.clone();
        invalid["value"][index]
            .as_object_mut()
            .unwrap()
            .remove("executable");
        assert_eq!(
            parse_snapshot_response(&invalid, &keys, true, 100),
            Err(expected)
        );
    }
    let mut mismatch = good;
    mismatch["context"]["slot"] = json!(124);
    assert_eq!(
        parse_snapshot_response(&mismatch, &keys, true, 100),
        Err(SnapshotError::BadClock(
            "slot differs from the context slot"
        ))
    );
    assert_eq!(SnapshotError::Rpc("secret URL".into()).code(), "Rpc");
}
