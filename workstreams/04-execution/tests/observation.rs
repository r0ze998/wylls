// WRITTEN ONLY. No tests, build, imports or syntax commands have been run.
use frontier_abi::v2::log::{self, AnyKind, CqKind};
use runexec::observation::{decode_observation, ObservedEvent};

// Synthetic ABI records, not chain evidence. The shared decoder accepts a
// zero-link envelope; the observation reader never admits chain validity.
fn body(kind: CqKind) -> Vec<u8> {
    let k = AnyKind::Cq(kind);
    let mut b = vec![frontier_abi::log::VERSION, k.code()];
    b.extend_from_slice(&9u32.to_le_bytes());
    b.extend_from_slice(&7u64.to_le_bytes());
    b.extend_from_slice(&3u32.to_le_bytes());
    b.resize(6 + k.key_len() + k.payload_len(), 0);
    b.push(0);
    b
}
fn put(b: &mut [u8], k: CqKind, name: &str, bytes: &[u8]) {
    let kind = AnyKind::Cq(k);
    let (off, len) = log::field(kind, name, true).expect("ABI field");
    assert_eq!(len, bytes.len());
    let start = 6 + kind.key_len() + off;
    b[start..start+len].copy_from_slice(bytes);
}
#[test]
fn settlement_keeps_transaction_slot_and_never_invents_credit() {
    let k = CqKind::CARAVAN_SETTLED;
    let mut b = body(k);
    put(&mut b, k, "dst", &[2, 3, 0, 0, 0, 4, 1, 4]);
    let mut cargo = [0u8; 32]; cargo[..4].copy_from_slice(&21u32.to_le_bytes());
    put(&mut b, k, "cargo", &cargo);
    match decode_observation(&b, 92, 123).unwrap() {
        ObservedEvent::CaravanSettled(s) => {
            assert_eq!(s.slot, 123); assert_eq!(s.key.owner, 7); assert_eq!(s.key.seq, 3);
            assert_eq!(s.cargo[0], 21); assert_eq!(s.credited, None); assert_eq!(s.dst.gen, 1);
        }
        _ => panic!("wrong kind"),
    }
}
#[test]
fn raid_keeps_choice_and_tx_slot() {
    let k = CqKind::CARAVAN_RAIDED;
    let mut b = body(k);
    put(&mut b, k, "choice", &[log::raid_choice::BURN]);
    put(&mut b, k, "raider_tag", &17u64.to_le_bytes());
    match decode_observation(&b, 93, 456).unwrap() {
        ObservedEvent::CaravanRaided(r) => {
            assert_eq!(r.slot, 456); assert_eq!(r.choice, log::raid_choice::BURN); assert_eq!(r.raider, 17);
        }
        _ => panic!("wrong kind"),
    }
}
#[test]
fn malformed_and_mislabeled_rows_are_refused() {
    assert!(decode_observation(&[], 92, 1).is_err());
    let b = body(CqKind::CARAVAN_RAIDED);
    assert!(decode_observation(&b, 92, 1).is_err());
    assert!(decode_observation(&b[..b.len()-1], 93, 1).is_err());
    let mut extra = b; extra.push(0);
    assert!(decode_observation(&extra, 93, 1).is_err());
}
#[test]
fn no_rpc_or_sender_is_required_by_decoder() {
    let mut b = body(CqKind::CARAVAN_RAIDED);
    put(&mut b, CqKind::CARAVAN_RAIDED, "choice", &[99]);
    assert!(decode_observation(&b, 93, 1).is_err());
}
