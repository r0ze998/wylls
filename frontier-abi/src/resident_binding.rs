//! Experimental immutable NFT-to-Citizen binding record.
//!
//! This codec does not establish account ownership or canonical addresses;
//! the runtime adapter must check those before using or creating a record.

pub const MAGIC: [u8; 8] = *b"PSFNR001";
pub const LEN: usize = 104;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub asset: [u8; 32],
    pub resident: [u8; 32],
    pub citizen: [u8; 32],
}

/// Read only an exact, initialized record; partial and unknown versions fail.
pub fn read(data: &[u8]) -> Option<Record> {
    if data.len() != LEN || data[..8] != MAGIC {
        return None;
    }
    Some(Record {
        asset: data[8..40].try_into().ok()?,
        resident: data[40..72].try_into().ok()?,
        citizen: data[72..104].try_into().ok()?,
    })
}

/// A decoded record must name the exact three accounts supplied by the runtime.
pub fn matches(record: &Record, asset: &[u8; 32], resident: &[u8; 32], citizen: &[u8; 32]) -> bool {
    &record.asset == asset && &record.resident == resident && &record.citizen == citizen
}

/// Write exactly once to an entirely zeroed record. The caller must first
/// verify program ownership, writable status, canonical address and authority.
pub fn write_once(data: &mut [u8], record: &Record) -> bool {
    if data.len() != LEN || data.iter().any(|&b| b != 0) {
        return false;
    }
    data[..8].copy_from_slice(&MAGIC);
    data[8..40].copy_from_slice(&record.asset);
    data[40..72].copy_from_slice(&record.resident);
    data[72..104].copy_from_slice(&record.citizen);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Literal bytes only. No setup, key operations, signing, IO or network.
    #[test]
    fn record_is_exact_and_cannot_be_rebound() {
        let record = Record {
            asset: [1; 32],
            resident: [2; 32],
            citizen: [3; 32],
        };
        let mut data = [0u8; LEN];
        assert_eq!(read(&data), None);
        assert!(write_once(&mut data, &record));
        assert_eq!(read(&data), Some(record));
        assert!(matches(&record, &[1; 32], &[2; 32], &[3; 32]));
        assert!(!matches(&record, &[9; 32], &[2; 32], &[3; 32]));
        assert!(!matches(&record, &[1; 32], &[9; 32], &[3; 32]));
        assert!(!matches(&record, &[1; 32], &[2; 32], &[9; 32]));
        let before = data;
        assert!(!write_once(
            &mut data,
            &Record {
                citizen: [4; 32],
                ..record
            }
        ));
        assert_eq!(data, before);
        assert_eq!(read(&data[..LEN - 1]), None);
        data[7] ^= 1;
        assert_eq!(read(&data), None);
        assert!(!write_once(&mut data, &record));
    }
}
