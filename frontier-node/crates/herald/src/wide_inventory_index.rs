//! Keyless, in-memory capture/index tests. No fixture modules or dispatch.
use super::*;
use crate::{clash::Provisional, files::Out, fold::FoldCfg};
use fclient::ports::Signature;
use frontier_abi::{layout::header, v2::layout::player::citizen as C};
use std::sync::{atomic::Ordering::Relaxed, Arc};

const ALICE: [u8; 32] = [9; 32];
const BOB: [u8; 32] = [10; 32];

fn fold() -> Fold {
    let mut f = Fold::new(
        FoldCfg {
            program: Address::new_from_array([0x5e; 32]),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        // No Out method performing IO is called by this suite.
        Out::new("/dev/null/wide-inventory-index-inert"),
    );
    for citizen in [ALICE, BOB] {
        let mut data = vec![0; C::SIZE];
        for slot in 1..=3 {
            let at = C::holding_of_slot(slot);
            data[at..at + 6].copy_from_slice(&[0, 0, 0, 0, 12, 0]);
        }
        f.st.accounts.insert(
            citizen,
            Capture {
                slot: 1,
                tx: 1,
                data,
            },
        );
    }
    f
}

fn record(f: &Fold, p: i64, owner: [u8; 32], slot: u8) -> ([u8; 32], Vec<u8>) {
    use frontier_abi::v2::layout::player::holding as H;
    use holding::wide_holding as W;
    let coord = WideCoord::checked(p, 0).unwrap();
    let mut data = vec![0; W::SIZE];
    data[header::MAGIC..header::MAGIC + 8].copy_from_slice(&W::MAGIC);
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&3u16.to_le_bytes());
    data[W::FAMILY_VERSION..W::FAMILY_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[W::STATUS] = W::STATUS_FOUNDED;
    data[W::SLOT] = slot;
    data[H::SITE] = 2;
    data[H::GEN] = 1;
    data[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(&owner);
    data[W::WORLD..W::WORLD + 32].copy_from_slice(f.wide.as_ref().unwrap().world().as_bytes());
    data[W::SORT_KEY..W::SORT_KEY + 17].copy_from_slice(&coord.sort_key());
    assert!(holding::WideHolding::read(&data).is_ok());
    (holding::holding_address(&f.ctx, coord, 2), data)
}

fn post(f: &mut Fold, key: [u8; 32], data: Option<Vec<u8>>, owner: Address) {
    let tx = TxRecord {
        seq: 12,
        slot: 34,
        signature: Signature::from([0; 64]),
        block_time: 0,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    };
    let account = data.map(|data| Account {
        owner,
        data,
        lamports: 1,
        executable: false,
    });
    assert!(capture_post(f, &key, account.as_ref(), &tx));
}
fn put(f: &mut Fold, key: [u8; 32], data: Vec<u8>) {
    let program = f.cfg.program;
    post(f, key, Some(data), program);
}
fn view(f: &Fold, citizen: &[u8; 32]) -> (Value, usize, usize) {
    let w = f.wide.as_ref().unwrap();
    w.inventory_reads.store(0, Relaxed);
    w.inventory_serializations.store(0, Relaxed);
    let value = holdings_for_citizen(f, citizen);
    (
        value,
        w.inventory_reads.load(Relaxed),
        w.inventory_serializations.load(Relaxed),
    )
}

#[test]
fn replacement_moves_owner_and_slot_and_close_cleans_empty_buckets() {
    let mut f = fold();
    let (key, first) = record(&f, 129, ALICE, 2);
    put(&mut f, key, first.clone());
    put(&mut f, key, first); // identical recapture must not duplicate membership
    let (v, reads, serialized) = view(&f, &ALICE);
    assert_eq!((reads, serialized), (1, 1));
    assert_eq!(v[0]["status"], "captured-unverified");
    assert_eq!(v[1]["status"], "not-captured");
    let (_, moved_slot) = record(&f, 129, ALICE, 3);
    put(&mut f, key, moved_slot);
    let slot_view = view(&f, &ALICE);
    assert_eq!(slot_view.0[0]["status"], "not-captured");
    assert_eq!(slot_view.0[1]["status"], "captured-unverified");
    assert_eq!((slot_view.1, slot_view.2), (1, 1));
    let (_, moved) = record(&f, 129, BOB, 3);
    put(&mut f, key, moved);
    assert_eq!(view(&f, &ALICE).1, 0);
    let (v, reads, serialized) = view(&f, &BOB);
    assert_eq!((reads, serialized), (1, 1));
    assert_eq!(v[0]["status"], "not-captured");
    assert_eq!(v[1]["holding"]["inventorySlot"], 3);
    assert_eq!(f.wide.as_ref().unwrap().inventory.len(), 1);
    post(&mut f, key, None, Address::new_from_array([0; 32]));
    assert_eq!(view(&f, &BOB).1, 0);
    let w = f.wide.as_ref().unwrap();
    assert!(w.inventory.is_empty() && w.inventory_of.is_empty() && w.holdings.is_empty());
    assert!(f.account(&key).is_none());
}

#[test]
fn refused_replacements_preserve_capture_and_reverse_membership() {
    let mut f = fold();
    let (key, data) = record(&f, 129, ALICE, 2);
    put(&mut f, key, data.clone());
    let expected = view(&f, &ALICE).0;
    let (_, changed) = record(&f, 129, BOB, 3);
    post(
        &mut f,
        key,
        Some(changed.clone()),
        Address::new_from_array([0; 32]),
    );
    put(&mut f, key, vec![0; 17]);
    let mut wrong_world = changed.clone();
    wrong_world[holding::wide_holding::WORLD..holding::wide_holding::WORLD + 32].fill(0x71);
    put(&mut f, key, wrong_world);
    let mut wrong_season = changed.clone();
    wrong_season[header::SEASON_ID] = 8;
    put(&mut f, key, wrong_season);
    let (_, wrong_address) = record(&f, 130, BOB, 3);
    put(&mut f, key, wrong_address);
    let program = f.cfg.program;
    post(&mut f, [0x74; 32], Some(changed), program);
    assert_eq!(f.account(&key).unwrap().data, data);
    assert_eq!(view(&f, &ALICE).0, expected);
    assert_eq!(view(&f, &BOB).1, 0);
    assert_eq!(f.wide.as_ref().unwrap().refused(), 6);
}

#[test]
fn player_lookup_reads_only_matching_slots_and_never_serializes_ambiguity() {
    let mut f = fold();
    let missing = view(&f, &ALICE);
    assert_eq!((missing.1, missing.2), (0, 0));
    let (key, data) = record(&f, 129, ALICE, 2);
    put(&mut f, key, data);
    let before = view(&f, &ALICE);
    for p in 200..1224 {
        let (key, data) = record(&f, p, BOB, 2);
        put(&mut f, key, data);
    }
    assert_eq!(f.wide.as_ref().unwrap().holdings.len(), 1025);
    assert_eq!(view(&f, &ALICE), before);
    assert_eq!((before.1, before.2), (1, 1));
    for p in 2000..2032 {
        let (key, data) = record(&f, p, ALICE, 2);
        put(&mut f, key, data);
    }
    let (key3, data3) = record(&f, 3000, ALICE, 3);
    put(&mut f, key3, data3);
    let (v, reads, serialized) = view(&f, &ALICE);
    assert_eq!((reads, serialized), (3, 1)); // two prove ambiguity, one for slot 3
    assert_eq!(
        v[0],
        json!({"inventorySlot": 2, "status": "ambiguous", "holding": null})
    );
    assert_eq!(v[1]["status"], "captured-unverified");
    for p in 2000..2032 {
        let (key, _) = record(&f, p, ALICE, 2);
        post(&mut f, key, None, Address::new_from_array([0; 32]));
    }
    assert_eq!(view(&f, &ALICE).0[0], before.0[0]);
}

#[test]
fn restart_rebuilds_reverse_index_and_preserves_read_only_envelope() {
    let mut f = fold();
    for (p, owner, slot) in [
        (129, ALICE, 2),
        (130, ALICE, 2),
        (131, ALICE, 3),
        (132, BOB, 3),
    ] {
        let (key, data) = record(&f, p, owner, slot);
        put(&mut f, key, data);
    }
    let before = view(&f, &ALICE);
    let bytes = crate::checkpoint::encode(&f.cfg.program.to_bytes(), f.cfg.season_id, &f.st);
    let state =
        crate::checkpoint::decode(&f.cfg.program.to_bytes(), f.cfg.season_id, &bytes).unwrap();
    let mut cfg = f.cfg.clone();
    cfg.exact_post = false;
    let restored = Fold::with_state(
        cfg,
        Out::new("/dev/null/wide-inventory-restart-inert"),
        state,
    );
    let (after, reads, serialized) = view(&restored, &ALICE);
    assert_eq!((reads, serialized), (before.1, before.2));
    assert_eq!(after[0], before.0[0]);
    let mut expected = before.0[1].clone();
    expected["holding"]["capture"]["postState"] = json!("at-or-after-transaction");
    assert_eq!(after[1], expected);
    let context = context_for_citizen(&restored, &ALICE);
    assert_eq!(context["readOnly"], true);
    assert_eq!(context["executable"], false);
    assert_eq!(context["verification"], "captured-unverified");
}

#[test]
fn missing_citizen_index_and_nonwide_bindings_keep_existing_shapes() {
    let mut f = fold();
    assert_eq!(holdings_for_citizen(&f, &[44; 32]), json!([]));
    for slot in 2..=3 {
        let at = C::holding_of_slot(slot);
        for bytes in [
            [0, 0, 0, 0, 0, 255],
            [0, 0, 0, 0, 2, 1],
            [0, 0, 0, 0, 99, 0],
        ] {
            f.st.accounts.get_mut(&ALICE).unwrap().data[at..at + 6].copy_from_slice(&bytes);
            assert!(view(&f, &ALICE)
                .0
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v["inventorySlot"] != slot));
        }
    }
    f.wide = None;
    assert_eq!(holdings_for_citizen(&f, &ALICE), json!([]));
    assert_eq!(context_for_citizen(&f, &ALICE), Value::Null);
}

/// This covers the real /h/me caller with wide-only inventory. Mixed legacy
/// inventory still uses views.rs's existing full-account host/ArrivalSlot scan;
/// the bounded assertion here is specifically the wide inventory lookup.
#[test]
fn actual_me_view_uses_index_with_canonical_citizen_and_unrelated_holdings() {
    let mut f = fold();
    let wallet = Address::new_from_array([0x29; 32]);
    let citizen = f.ctx.citizen(&wallet.to_bytes());
    let mut data = vec![0; C::SIZE];
    data[..8].copy_from_slice(b"PSF1CITZ");
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&2u16.to_le_bytes());
    data[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet.to_bytes());
    data[C::HOLDINGS_N] = 2;
    data[C::holding_of_slot(1)..C::holding_of_slot(1) + 6].copy_from_slice(&[0, 0, 0, 0, 0, 255]);
    for slot in 2..=3 {
        data[C::holding_of_slot(slot)..C::holding_of_slot(slot) + 6]
            .copy_from_slice(&[0, 0, 0, 0, 12, 0]);
    }
    assert_eq!(
        fclient::decode::Citizen::decode(&data).unwrap().wallet,
        wallet
    );
    f.st.accounts.insert(
        citizen,
        Capture {
            slot: 1,
            tx: 1,
            data,
        },
    );
    for (p, slot) in [(129, 2), (130, 3)] {
        let (key, data) = record(&f, p, citizen, slot);
        put(&mut f, key, data);
    }
    let expected = view(&f, &citizen).0;
    let before = crate::views::me_json(&f, &wallet, Value::Null);
    for p in 200..1224 {
        let (key, data) = record(&f, p, BOB, 2);
        put(&mut f, key, data);
    }
    let w = f.wide.as_ref().unwrap();
    w.inventory_reads.store(0, Relaxed);
    w.inventory_serializations.store(0, Relaxed);
    let after = crate::views::me_json(&f, &wallet, Value::Null);
    assert_eq!(after, before);
    assert_eq!(after["wideHoldings"], expected);
    assert_eq!(
        after["citizen"]["address"],
        Address::new_from_array(citizen).to_string()
    );
    assert_eq!(after["wideContext"]["citizen"], after["citizen"]["address"]);
    assert_eq!(after["wideContext"]["readOnly"], true);
    assert_eq!(after["wideContext"]["executable"], false);
    for field in ["holdings", "hosts", "transits", "slots", "seals"] {
        assert_eq!(after[field], json!([]));
    }
    assert_eq!(w.inventory_reads.load(Relaxed), 2);
    assert_eq!(w.inventory_serializations.load(Relaxed), 2);
}
