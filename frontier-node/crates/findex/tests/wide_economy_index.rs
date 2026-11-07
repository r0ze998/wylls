//! The dedicated wide index over the economy receipt kinds (15 `Economy`,
//! 16 `EconomyMirror`): fixed bytes built with the ABI's encoder and
//! literal digests. No signing, keypair, network, program execution, digest
//! verification or live-world claim; only the public SHA chain rule is
//! recomputed, as the index does for every chained kind.
#![cfg(feature = "wide-records-experimental")]

use base64::Engine;
use fclient::{
    ports::{Signature, TxRecord},
    Address,
};
use findex::wide_index::WideIndex;
use frontier_abi::world_index::{
    event as e, EconomyAction, EconomyReceipt, ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use std::path::{Path, PathBuf};

fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn world() -> WorldId {
    WorldId::new([7; 32]).unwrap()
}
fn own() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(129, 0).unwrap())
}
/// The holding reference (site 3, generation 17, sequence 0).
fn holding() -> WideHostRef {
    WideHostRef::new(own(), 3, 17, 0).unwrap()
}
fn tmp() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "wide-economy-index-{}-{serial}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
fn index(path: &Path) -> WideIndex {
    WideIndex::open(path, program(), world()).unwrap()
}
fn line(body: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b.encode(b"PSW1"), b.encode(body))
}
fn tx(seq: u64, lines: Vec<String>) -> TxRecord {
    let mut sig = [0; 64];
    sig[..8].copy_from_slice(&seq.to_le_bytes());
    TxRecord {
        seq,
        slot: 100 + seq,
        signature: Signature::from(sig),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(&program(), lines),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
fn receipt(action: EconomyAction) -> Vec<u8> {
    e::economy_payload(&EconomyReceipt {
        action,
        now_ts: 1_700_060_000,
        became_final: false,
        input_digest: [0x1A; 32],
        output_digest: [0x0B; 32],
    })
    .unwrap()
    .to_vec()
}
/// The chains of the one province and the one holding, advanced by the
/// records built here (the index recomputes exactly this).
#[derive(Default)]
struct Chains {
    province: (u64, [u8; 32]),
    holding: (u64, [u8; 32]),
}
impl Chains {
    fn economy(&mut self, action: EconomyAction) -> Vec<u8> {
        let kind = action.kind();
        let key = holding().to_bytes();
        let payload = receipt(action);
        let mut b = vec![0; e::MAX_BODY];
        let n = e::write_body(kind, 9, &key, &payload, &mut b).unwrap();
        let mut links = Vec::new();
        for entity in kind.links() {
            let old = match entity {
                e::WideEntity::Province => &mut self.province,
                e::WideEntity::Holding => &mut self.holding,
            };
            let next = e::advance(*entity, old.0, &old.1, &b[..n]).unwrap();
            *old = (next.seq, next.head);
            links.push(next);
        }
        e::encode(kind, 9, &key, &payload, &links).unwrap()
    }
}
const WALLS: EconomyAction = EconomyAction::Build { item: 6 };
const TIER_UP: EconomyAction = EconomyAction::Build { item: 7 };

#[test]
fn a_holding_only_receipt_advances_the_holding_chain_alone_and_names_no_host() {
    let path = tmp();
    let mut i = index(&path);
    let mut c = Chains::default();
    let harvest = c.economy(EconomyAction::Harvest);
    let train = c.economy(EconomyAction::Train { unit: 0, n: 100 });
    i.add(&[tx(1, vec![line(&harvest)]), tx(2, vec![line(&train)])])
        .unwrap();
    i.mark_caught_up(2).unwrap();
    let page = i.events(0, 16).unwrap();
    assert_eq!(page.events.len(), 2);
    for ev in &page.events {
        assert_eq!(ev.format, "PSW1");
        assert_eq!(ev.province, Some(own().to_bytes().to_vec()));
        assert_eq!(ev.holding, Some(holding().to_bytes().to_vec()));
        assert!(ev.host.is_none(), "a holding key derives no host");
    }
    assert_eq!(page.events[0].body, harvest);
    assert_eq!(page.events[1].body, train);
    let h = i.chain(e::WideTarget::Holding(holding())).unwrap().unwrap();
    assert_eq!((h.seq, h.terminal), (2, false));
    assert_eq!(h.head, c.holding.1);
    assert!(
        i.chain(e::WideTarget::Province(own())).unwrap().is_none(),
        "an Economy chains no province"
    );
    drop(i);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_mirror_receipt_advances_the_province_and_the_holding() {
    let path = tmp();
    let mut i = index(&path);
    let mut c = Chains::default();
    let harvest = c.economy(EconomyAction::Harvest);
    let walls = c.economy(WALLS);
    let tier = c.economy(TIER_UP);
    i.add(&[tx(1, vec![line(&harvest), line(&walls), line(&tier)])])
        .unwrap();
    i.mark_caught_up(1).unwrap();
    assert_eq!(i.events(0, 16).unwrap().events.len(), 3);
    let p = i.chain(e::WideTarget::Province(own())).unwrap().unwrap();
    assert_eq!((p.seq, p.terminal), (2, false));
    assert_eq!(p.head, c.province.1);
    let h = i.chain(e::WideTarget::Holding(holding())).unwrap().unwrap();
    assert_eq!(h.seq, 3);
    assert_eq!(h.head, c.holding.1);
    // a mirror receipt of the walls action under the holding-only kind
    // is not a record: the typed reader refuses the transaction
    let mut mislabelled = walls.clone();
    mislabelled[1] = e::WideKind::Economy as u8;
    assert!(i.add(&[tx(2, vec![line(&mislabelled)])]).is_err());
    assert!(i.status().unwrap().blocked.is_some());
    drop(i);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_failed_transaction_indexes_no_receipt_and_moves_no_chain() {
    let path = tmp();
    let mut i = index(&path);
    let mut c = Chains::default();
    let body = c.economy(WALLS);
    let mut failed = tx(1, vec![line(&body)]);
    failed.err = Some("rollback".into());
    i.add(&[failed]).unwrap();
    i.mark_caught_up(1).unwrap();
    assert!(i.events(0, 16).unwrap().events.is_empty());
    assert!(i.chain(e::WideTarget::Province(own())).unwrap().is_none());
    assert!(i
        .chain(e::WideTarget::Holding(holding()))
        .unwrap()
        .is_none());
    // the same body, committed later, starts the chains from zero
    i.add(&[tx(2, vec![line(&body)])]).unwrap();
    i.mark_caught_up(2).unwrap();
    assert_eq!(
        i.chain(e::WideTarget::Holding(holding()))
            .unwrap()
            .unwrap()
            .seq,
        1
    );
    drop(i);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_tampered_receipt_or_link_blocks_the_whole_batch() {
    for mode in 0..3 {
        let path = tmp();
        let mut i = index(&path);
        let mut c = Chains::default();
        let first = c.economy(EconomyAction::Harvest);
        let mut second = c.economy(WALLS);
        let payload_at = e::HEAD_LEN + e::HOLDING_KEY_LEN;
        match mode {
            // the holding link's head
            0 => *second.last_mut().unwrap() ^= 1,
            // the receipt's output digest (the body hashes into the links)
            1 => second[payload_at + 1 + 6 + 8 + 1 + 32] ^= 1,
            // the province link's sequence
            _ => {
                let tail = payload_at + e::ECONOMY_PAYLOAD_LEN + 1;
                second[tail + 1] ^= 1;
            }
        }
        assert!(i
            .add(&[tx(1, vec![line(&first)]), tx(2, vec![line(&second)])])
            .is_err());
        assert_eq!(i.status().unwrap().last_seq, 0, "mode {mode}");
        assert!(i.status().unwrap().blocked.is_some());
        assert!(i.events(0, 1).is_err());
        drop(i);
        std::fs::remove_file(path).unwrap();
    }
}
