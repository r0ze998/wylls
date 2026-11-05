//! Isolated NFT-join record design. NOT a PS2 event or an allocated ABI.
//!
//! The decoder only establishes syntax. Every field is an untrusted claim;
//! it does not prove a canonical binding, current ownership, transaction
//! signature, successful execution, log completeness or finality. A verifier
//! needs the corresponding trusted transaction/account evidence and the
//! accepted program and policy before deriving facts. `owner_at_join` is
//! historical and must never authorize later actions after a transfer.
//!
//! Legacy `JOIN` bytes and PS2's version/kind table are deliberately untouched.
//! Season, bell, chain links and event version belong to a future integrated
//! envelope and are deliberately not represented by this candidate payload.

use crate::bytes::{Cursor, Writer};

const MARKER: [u8; 8] = *b"NFTJOIN1";
pub const LEN: usize = 214;

/// A syntactically decoded proposal, not an established identity or entitlement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UntrustedJoin {
    pub asset: [u8; 32],
    pub citizen: [u8; 32],
    pub binding: [u8; 32],
    pub resident: [u8; 32],
    pub owner_at_join: [u8; 32],
    pub generation: u32,
    pub faction: u8,
    pub shard: u8,
    pub session: [u8; 32],
    pub session_expiry: i64,
}

/// Candidate serialization. No event tag or PS2 body is allocated here.
pub fn encode(record: &UntrustedJoin, out: &mut [u8]) -> Option<usize> {
    if out.len() != LEN || record.faction >= 6 || record.shard >= 8 {
        return None;
    }
    let mut w = Writer::new(out);
    w.bytes(&MARKER)
        .bytes(&record.asset)
        .bytes(&record.citizen)
        .bytes(&record.binding)
        .bytes(&record.resident)
        .bytes(&record.owner_at_join)
        .u32(record.generation)
        .u8(record.faction)
        .u8(record.shard)
        .bytes(&record.session)
        .i64(record.session_expiry);
    w.finish()
}

/// Decode exactly this proposed format without treating its contents as proof.
pub fn decode(bytes: &[u8]) -> Option<UntrustedJoin> {
    if bytes.len() != LEN {
        return None;
    }
    let mut c = Cursor::new(bytes);
    if c.arr::<8>()? != MARKER {
        return None;
    }
    let result = UntrustedJoin {
        asset: c.arr()?,
        citizen: c.arr()?,
        binding: c.arr()?,
        resident: c.arr()?,
        owner_at_join: c.arr()?,
        generation: c.u32()?,
        faction: c.u8()?,
        shard: c.u8()?,
        session: c.arr()?,
        session_expiry: c.i64()?,
    };
    if result.faction >= 6 || result.shard >= 8 || !c.done() {
        return None;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::{self, Kind, LogError};

    // Fixed bytes only. No common fixture, key generation, derivation, signing,
    // I/O, hashing, network or runtime accounts.
    #[test]
    fn candidate_roundtrip_and_legacy_join_remain_distinct() {
        let candidate = UntrustedJoin {
            asset: [1; 32],
            citizen: [2; 32],
            binding: [3; 32],
            resident: [4; 32],
            owner_at_join: [5; 32],
            generation: 7,
            faction: 3,
            shard: 4,
            session: [6; 32],
            session_expiry: 1234,
        };
        let mut wire = [0u8; LEN];
        assert_eq!(encode(&candidate, &mut wire), Some(LEN));
        assert_eq!(decode(&wire), Some(candidate));
        assert_eq!(decode(&wire[..LEN - 1]), None);
        let mut longer = [0u8; LEN + 1];
        longer[..LEN].copy_from_slice(&wire);
        assert_eq!(decode(&longer), None);
        assert!(matches!(log::decode(&wire), Err(LogError::Version(_))));
        assert!(matches!(
            crate::v2::log::decode(&wire),
            Err(LogError::Version(_))
        ));
        // Synthetic unknown record: the verifier's exact decoder must not
        // guess its tail or reinterpret it as a known legacy JOIN.
        assert!(matches!(
            crate::v2::log::decode(&[1, 0xff, 0, 0, 0, 0, 0]),
            Err(LogError::UnknownKind(0xff))
        ));
        wire[0] ^= 1;
        assert_eq!(decode(&wire), None);
        let mut invalid = candidate;
        invalid.faction = 6;
        assert_eq!(encode(&invalid, &mut [0u8; LEN]), None);
        invalid = candidate;
        invalid.shard = 8;
        assert_eq!(encode(&invalid, &mut [0u8; LEN]), None);

        // The old JOIN stays byte-compatible and decodes using the old codec.
        assert_eq!(Kind::JOIN.spec().key_len(), 15);
        assert_eq!(Kind::JOIN.spec().payload_len(), 74);
        let key = [9u8; 15];
        let payload = [10u8; 74];
        let mut legacy = [0u8; 96];
        let n = log::write_body(Kind::JOIN, 42, &key, &payload, &mut legacy).unwrap();
        let len = log::write_tail(&[], &mut legacy, n).unwrap();
        assert_eq!(len, legacy.len());
        let parsed = log::decode(&legacy).unwrap();
        assert_eq!(parsed.kind, Kind::JOIN);
        assert_eq!(parsed.key, key);
        assert_eq!(parsed.payload, payload);
        let parsed_v2 = crate::v2::log::decode(&legacy).unwrap();
        assert!(matches!(
            parsed_v2.kind,
            crate::v2::log::AnyKind::V1(Kind::JOIN)
        ));
        assert_eq!(parsed_v2.key, key);
        assert_eq!(parsed_v2.payload, payload);
        assert_eq!(decode(&legacy), None);
    }
}
