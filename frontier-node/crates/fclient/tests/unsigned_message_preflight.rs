use fclient::unsigned_message_preflight::{inspect, BlockhashObservation, Error, Limits};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;

fn fixture() -> (Message, [Address; 1], BlockhashObservation, Limits) {
    // Fixed public bytes only. No key generation, secret derivation or signing.
    let payer = Address::new_from_array([21; 32]);
    let message = Message::new_with_blockhash(
        &[Instruction {
            program_id: Address::new_from_array([22; 32]),
            accounts: vec![AccountMeta::new(Address::new_from_array([23; 32]), false)],
            data: vec![7; 60],
        }],
        Some(&payer),
        &Hash::new_from_array([24; 32]),
    );
    (
        message,
        [payer],
        BlockhashObservation {
            blockhash: [24; 32],
            context_slot: 101,
            valid: true,
            block_height: 200,
            last_valid_block_height: 210,
        },
        Limits {
            max_locks: 32,
            max_writes: 8,
            min_context_slot: 100,
            min_remaining_block_heights: 2,
        },
    )
}

#[test]
fn fixed_public_message_has_exact_wire_size_but_never_admission() {
    let (m, s, o, l) = fixture();
    let r = inspect(&m, &s, o, l).unwrap();
    assert_eq!(r.shape.bytes, 262);
    assert_eq!((r.shape.locks, r.shape.writes, r.shape.sigs), (3, 2, 1));
    assert_eq!(r.remaining_block_heights, 10);
    assert!(!r.admitted());
    assert!(!r.public_dispatch_available());
    assert!(!r.rpc_authority_verified());
}

#[test]
fn malformed_headers_and_indices_fail_without_panics() {
    let (m, s, o, l) = fixture();
    let mut bad = m.clone();
    bad.header.num_readonly_signed_accounts = 2;
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::Header));
    bad = m.clone();
    bad.header.num_readonly_unsigned_accounts = 255;
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::Header));
    bad = m.clone();
    bad.header.num_required_signatures = 128;
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::Header));
    bad = m.clone();
    bad.instructions[0].program_id_index = 255;
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::InstructionIndex));
    bad = m.clone();
    bad.instructions[0].accounts.push(255);
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::InstructionIndex));
    bad = m.clone();
    bad.account_keys[2] = bad.account_keys[1];
    assert_eq!(inspect(&bad, &s, o, l), Err(Error::DuplicateAccount));
    assert_eq!(inspect(&m, &[], o, l), Err(Error::Signers));
}

#[test]
fn packet_boundary_includes_reserved_signature_bytes() {
    let (mut m, s, o, l) = fixture();
    // Short-vec data length uses a second byte above 127.
    m.instructions[0].data.resize(1029, 7);
    assert_eq!(inspect(&m, &s, o, l).unwrap().shape.bytes, 1232);
    m.instructions[0].data.push(7);
    assert_eq!(inspect(&m, &s, o, l), Err(Error::PacketSize));
}

#[test]
fn observation_must_match_context_validity_expiry_and_margin() {
    let (m, s, o, l) = fixture();
    assert_eq!(
        inspect(
            &m,
            &s,
            BlockhashObservation {
                blockhash: [25; 32],
                ..o
            },
            l
        ),
        Err(Error::BlockhashMismatch)
    );
    assert_eq!(
        inspect(
            &m,
            &s,
            BlockhashObservation {
                context_slot: 99,
                ..o
            },
            l
        ),
        Err(Error::BlockhashContext)
    );
    assert_eq!(
        inspect(&m, &s, BlockhashObservation { valid: false, ..o }, l),
        Err(Error::BlockhashInvalid)
    );
    assert_eq!(
        inspect(
            &m,
            &s,
            BlockhashObservation {
                block_height: 211,
                ..o
            },
            l
        ),
        Err(Error::BlockhashExpired)
    );
    assert_eq!(
        inspect(
            &m,
            &s,
            BlockhashObservation {
                block_height: 209,
                ..o
            },
            l
        ),
        Err(Error::BlockhashMargin)
    );
    assert_eq!(
        inspect(
            &m,
            &s,
            o,
            Limits {
                max_locks: 2,
                max_writes: 2,
                ..l
            }
        ),
        Err(Error::AccountLocks)
    );
    assert_eq!(
        inspect(&m, &s, o, Limits { max_writes: 1, ..l }),
        Err(Error::WritableLocks)
    );
}
