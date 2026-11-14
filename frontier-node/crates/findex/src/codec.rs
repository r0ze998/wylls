//! TEST-ONLY opt-in storage codec for a NEW store (round 13, 2026-11-14).
//!
//! A long two-person test world's store grew ≈0.4 MiB per turn, 95% of it the archive's frames and the index's
//! `snapshot` rows: every transaction keeps the whole post-state of each account it wrote (a province is ≈4.7 KB, mostly
//! zero bytes), once as base64 JSON in the archive frame and once as a blob in the index. [`Codec::GzipV1`] stores both
//! gzip-compressed. Nothing is dropped, thinned or summarised: every record keeps every byte, and decoding gives back
//! exactly the bytes that were encoded.
//!
//! * The default is [`Codec::Plain`]: the bytes written are exactly those written before this module existed (no
//!   manifest key, no index meta row, the same frames and blobs).
//! * The codec is chosen when a store is CREATED and recorded with it (the archive manifest's `codec`, the index's
//!   `snapshot_codec` meta row). Opening a store with another codec than the one it records is refused — never a
//!   mixed store.
//! * Decoding is bounded ([`decode`]'s `max`): an entry that would inflate past it is refused, never read on.
//! * Integrity: an archive frame still carries the sha256 prefix of the bytes as STORED (the frame check and the crash
//!   tail truncation are unchanged); gzip's own CRC-32 and length of the decoded bytes are checked on every decode; a
//!   second gzip member or trailing bytes are refused. The archive's sequence checks run on the decoded records, as
//!   before.

use std::io::{Read, Write};

// (bufread over the stored slice: no buffer of its own, so what is left after the member is exactly what into_inner gives)
use flate2::bufread::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

/// How a store keeps its archive frames and snapshot blobs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Codec {
    /// As always (the default): raw JSON frames, raw snapshot bytes.
    #[default]
    Plain,
    /// TEST-ONLY, a new store only: each frame payload and each snapshot `data` blob gzip-compressed.
    GzipV1,
}

/// The word a store records for [`Codec::GzipV1`].
pub const GZIP_V1: &str = "gzip-v1";
/// The most one archive frame may decode to.
pub const FRAME_DECODE_MAX: usize = 64 * 1024 * 1024;
/// The most one snapshot blob may decode to (an account's data is at most 10 MiB).
pub const SNAPSHOT_DECODE_MAX: usize = 10 * 1024 * 1024 + 4096;

impl Codec {
    /// The recorded word: `None` for the default (nothing is recorded).
    pub fn word(self) -> Option<&'static str> {
        match self {
            Codec::Plain => None,
            Codec::GzipV1 => Some(GZIP_V1),
        }
    }

    /// From a recorded word (`None`: nothing recorded = the default); an unknown word is an error.
    pub fn from_word(w: Option<&str>) -> Result<Codec, String> {
        match w {
            None => Ok(Codec::Plain),
            Some(GZIP_V1) => Ok(Codec::GzipV1),
            Some(other) => Err(format!("unknown store codec {other:?}")),
        }
    }

    /// The bytes to store for `raw`.
    pub fn encode(self, raw: &[u8]) -> Vec<u8> {
        match self {
            Codec::Plain => raw.to_vec(),
            Codec::GzipV1 => {
                let mut e = GzEncoder::new(Vec::with_capacity(raw.len() / 4 + 64), Compression::default());
                e.write_all(raw).expect("writing to memory");
                e.finish().expect("writing to memory")
            }
        }
    }

    /// The raw bytes back from what was stored, at most `max` of them.
    pub fn decode(self, stored: &[u8], max: usize) -> Result<Vec<u8>, String> {
        match self {
            Codec::Plain => Ok(stored.to_vec()),
            Codec::GzipV1 => decode(stored, max),
        }
    }
}

/// One gzip member → its bytes, at most `max`; anything else is refused: an entry longer than `max` once decoded, a bad
/// CRC-32 or length, a truncated member, a second member or trailing bytes.
pub fn decode(stored: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let mut d = GzDecoder::new(stored);
    let mut out = Vec::with_capacity(stored.len().saturating_mul(4).min(max));
    let n = (&mut d)
        .take(max as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("store codec: not a valid gzip entry: {e}"))?;
    if n > max {
        return Err(format!("store codec: an entry decodes past its limit of {max} bytes"));
    }
    if !d.into_inner().is_empty() {
        return Err("store codec: bytes after the gzip entry".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn province_like() -> Vec<u8> {
        let mut v = vec![0u8; 4736];
        v[..8].copy_from_slice(b"PSF1PROV");
        for i in (64..4736).step_by(97) {
            v[i] = (i % 251) as u8;
        }
        v
    }

    #[test]
    fn plain_is_the_bytes_themselves_and_records_nothing() {
        let raw = province_like();
        assert_eq!(Codec::Plain.encode(&raw), raw);
        assert_eq!(Codec::Plain.decode(&raw, 1).unwrap(), raw, "plain is never bounded or changed");
        assert_eq!(Codec::default(), Codec::Plain);
        assert_eq!(Codec::Plain.word(), None);
        assert_eq!(Codec::from_word(None).unwrap(), Codec::Plain);
    }

    #[test]
    fn gzip_gives_back_exactly_the_bytes_and_is_smaller_for_a_province() {
        let raw = province_like();
        let s = Codec::GzipV1.encode(&raw);
        assert_eq!(&s[..2], &[0x1f, 0x8b]);
        assert!(s.len() * 4 < raw.len(), "{} of {}", s.len(), raw.len());
        assert_eq!(Codec::GzipV1.decode(&s, SNAPSHOT_DECODE_MAX).unwrap(), raw);
        assert_eq!(Codec::GzipV1.decode(&Codec::GzipV1.encode(&[]), 0).unwrap(), Vec::<u8>::new());
        assert_eq!(Codec::from_word(Some(GZIP_V1)).unwrap(), Codec::GzipV1);
        assert_eq!(Codec::GzipV1.word(), Some("gzip-v1"));
    }

    #[test]
    fn every_bad_entry_is_refused() {
        let raw = province_like();
        let s = Codec::GzipV1.encode(&raw);
        // past the limit (exactly the limit is fine)
        assert!(decode(&s, raw.len() - 1).unwrap_err().contains("limit"));
        assert_eq!(decode(&s, raw.len()).unwrap(), raw);
        // a bad CRC-32 (the trailer's first byte), a bad length (its last), a flipped body byte, a truncated member
        let mut crc = s.clone();
        let n = crc.len();
        crc[n - 8] ^= 1;
        assert!(decode(&crc, SNAPSHOT_DECODE_MAX).is_err(), "crc");
        let mut len = s.clone();
        len[n - 1] ^= 1;
        assert!(decode(&len, SNAPSHOT_DECODE_MAX).is_err(), "length");
        let mut body = s.clone();
        body[n / 2] ^= 0x55;
        assert!(decode(&body, SNAPSHOT_DECODE_MAX).is_err(), "body");
        assert!(decode(&s[..n - 3], SNAPSHOT_DECODE_MAX).is_err(), "truncated");
        // a second member, trailing bytes, not gzip at all
        let mut two = s.clone();
        two.extend_from_slice(&s);
        assert!(decode(&two, 2 * SNAPSHOT_DECODE_MAX).unwrap_err().contains("after"));
        let mut tail = s.clone();
        tail.push(0);
        assert!(decode(&tail, SNAPSHOT_DECODE_MAX).is_err());
        assert!(decode(b"{\"seq\":1}", SNAPSHOT_DECODE_MAX).is_err());
        assert!(Codec::from_word(Some("gzip-v2")).is_err());
        assert!(Codec::from_word(Some("")).is_err());
    }
}
