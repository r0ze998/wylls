//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **wide march seal**: a versioned plaintext that commits to the full
//! host reference and the full destination key, sealed with the deployed
//! tlock envelope and opened through the deployed opener.
//!
//! **Why a second plaintext.** The deployed `Plain37`
//! (`permutation_rules::frontier::seal`) authenticates an `i16` destination
//! pair and a `u64` host id: no wide province fits either, and a wide
//! march whose destination or host were supplied beside the seal as plain
//! instruction data would let a settler or a forfeiter steer the march to
//! another province or another host. The wide plaintext therefore carries
//! the **56-byte host reference** and the **50-byte destination key**
//! inside the committed bytes, and nothing about either is taken from
//! anywhere else.
//!
//! **Seal (264 B):** `U (96, compressed G2) ‖ V (16) ‖ W (16) ‖ body (136)`.
//! The first 128 bytes are the deployed compact-16 IBE block, unchanged:
//! the same `k` recovery, the same Fujisaki–Okamoto check, the same
//! `salt = sha256("PS-SALT" ‖ k)`. The body is the 136-byte plaintext XOR
//! the deployed keystream of `k` (`seal::keystream_xor`: the same two
//! blocks the 37-byte body uses, then the continued counter). The legacy
//! 165-byte seal, its 37-byte plaintext, `PS-FRONTIER-MARCH-v1` commitment
//! and every vector are untouched; a wide seal is a different length and
//! a different commitment domain, so neither can be read as the other.
//!
//! **Plaintext (136 B):**
//!
//! | Off | Size | Field |
//! |---|---|---|
//! | 0 | 1 | version u8 (= 2) |
//! | 1 | 56 | host reference (`WideHostRef`, its own version byte first) |
//! | 57 | 4 | arrive_bell u32 |
//! | 61 | 50 | destination province key (`ProvinceKey`) |
//! | 111 | 1 | dest tile u8 (0..61) |
//! | 112 | 1 | stance u8 (0 Hold, 1 Assault, 2 Flank, 3 Brace) |
//! | 113 | 2 | retreat_bps u16 (0 = never; 1..=60,000) |
//! | 115 | 1 | path_len u8 (≤ 32) |
//! | 116 | 12 | path: 32 × 3-bit directions (the deployed encoding) |
//! | 128 | 8 | reserved (0) |
//!
//! The path provinces are not listed: as deployed, a reveal walks the
//! directions from the host's standing tile and derives every province it
//! enters, so the committed path is the committed route.
//!
//! **Commitment:** `commit = sha256("PS-FRONTIER-MARCH-WIDE-v1" ‖ plain136
//! ‖ salt)`, `seal_root = sha256(commit ‖ sha256(seal))` (the deployed
//! shape over the wide bytes).
//!
//! **What is tested, what is not.** The codec, the validation, the body
//! keystream and the commitment are pure and pinned by fixed bytes here
//! and by the program's host tests over the recorded seal vectors' keys.
//! The pairing and the FO check are the deployed opener's, which the host
//! cannot run (the BLS syscalls are fail-closed stubs there), so **no test
//! here or in the program demonstrates a real decryption of a wide seal**;
//! `open_body` under a recorded key is a body/commitment check, nothing
//! more. Nothing here generates a key, a signature or a seal. No handler
//! reads a wide seal yet.
//!
//! **The beacon binds the bell, not the region.** Every region of one
//! bell shares the round `T(arrive)`, so a seal that opens under the
//! round's signature proves the arrival bell and nothing about the
//! destination's region. A wide reveal or settle must therefore read the
//! destination from the committed plaintext, derive its region by the
//! configured experimental region rule, require THE anchor (or archive
//! entry) of exactly that region and bell at its canonical address, use
//! `T(arrive)` only to open the seal, and take the combat seed `S(A)` from
//! that anchor's own `A`, as the deployed SettleTransit does with the
//! legacy region. The destination is never taken from an account the
//! caller chose.

use super::key::{KeyError, ProvinceKey, WideHostRef, HOST_REF_LEN, PROVINCE_KEY_LEN};
use permutation_rules::frontier::geometry::PROVINCE_TILES;
use permutation_rules::frontier::seal as ks;
use permutation_rules::frontier::travel::MAX_PATH_STEPS;
use permutation_rules::hash::sha256;

/// Plaintext version of a wide march (the deployed plaintext is 1).
pub const WIDE_PLAIN_VERSION: u8 = 2;
/// Bytes of the wide plaintext.
pub const WIDE_PLAIN_LEN: usize = 136;
/// Reserved tail of the plaintext.
pub const WIDE_RESERVED_BYTES: usize = 8;
/// The deployed IBE block (`U ‖ V ‖ W`), the first bytes of every seal.
pub const IBE_LEN: usize = ks::SEAL_BODY;
/// Bytes of a wide seal.
pub const WIDE_SEAL_LEN: usize = IBE_LEN + WIDE_PLAIN_LEN;
/// Commitment domain of a wide march (distinct from `PS-FRONTIER-MARCH-v1`).
pub const DOMAIN_MARCH_WIDE: &[u8] = b"PS-FRONTIER-MARCH-WIDE-v1";

/// Offsets of the plaintext.
pub mod off {
    use super::{HOST_REF_LEN, PROVINCE_KEY_LEN};
    pub const VERSION: usize = 0;
    pub const HOST: usize = 1;
    pub const ARRIVE_BELL: usize = HOST + HOST_REF_LEN;
    pub const DEST: usize = ARRIVE_BELL + 4;
    pub const DEST_TILE: usize = DEST + PROVINCE_KEY_LEN;
    pub const STANCE: usize = DEST_TILE + 1;
    pub const RETREAT_BPS: usize = STANCE + 1;
    pub const PATH_LEN: usize = RETREAT_BPS + 2;
    pub const PATH: usize = PATH_LEN + 1;
    pub const RESERVED: usize = PATH + super::ks::PATH_BYTES;
    const _: () = assert!(RESERVED + super::WIDE_RESERVED_BYTES == super::WIDE_PLAIN_LEN);
    const _: () = assert!(super::IBE_LEN == 128 && super::WIDE_SEAL_LEN == 264);
}

/// A wide march plaintext, field for field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidePlain {
    pub version: u8,
    pub host: WideHostRef,
    pub arrive_bell: u32,
    pub dest: ProvinceKey,
    pub dest_tile: u8,
    pub stance: u8,
    pub retreat_bps: u16,
    pub path_len: u8,
    pub path: [u8; ks::PATH_BYTES],
    /// Must be zero ([`validate`]).
    pub reserved: [u8; WIDE_RESERVED_BYTES],
}

/// Why wide plaintext bytes do not decode, or a decoded plaintext is not
/// this march's (a reveal refuses; a settle judges the seal code 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidePlainError {
    Version,
    Reserved,
    /// The host reference bytes do not decode.
    Host(KeyError),
    /// The destination key bytes do not decode.
    Dest(KeyError),
    /// The committed host is not the transit's.
    HostMismatch,
    ArriveMismatch,
    /// The destination lies in another world than the host.
    WorldMismatch,
    PathTooLong,
    PathBits,
    Direction,
    Tile,
    Stance,
    Retreat,
}

/// Packs a plaintext into its 136 bytes.
pub fn pack(pt: &WidePlain) -> [u8; WIDE_PLAIN_LEN] {
    let mut b = [0u8; WIDE_PLAIN_LEN];
    b[off::VERSION] = pt.version;
    b[off::HOST..off::HOST + HOST_REF_LEN].copy_from_slice(&pt.host.to_bytes());
    b[off::ARRIVE_BELL..off::ARRIVE_BELL + 4].copy_from_slice(&pt.arrive_bell.to_le_bytes());
    b[off::DEST..off::DEST + PROVINCE_KEY_LEN].copy_from_slice(&pt.dest.to_bytes());
    b[off::DEST_TILE] = pt.dest_tile;
    b[off::STANCE] = pt.stance;
    b[off::RETREAT_BPS..off::RETREAT_BPS + 2].copy_from_slice(&pt.retreat_bps.to_le_bytes());
    b[off::PATH_LEN] = pt.path_len;
    b[off::PATH..off::PATH + ks::PATH_BYTES].copy_from_slice(&pt.path);
    b[off::RESERVED..].copy_from_slice(&pt.reserved);
    b
}

/// Unpacks 136 bytes. Unlike the deployed `unpack`, not total: the host
/// reference and the destination key are versioned structures and may not
/// decode (`Host`, `Dest`); [`validate`] decides the rest.
pub fn unpack(b: &[u8; WIDE_PLAIN_LEN]) -> Result<WidePlain, WidePlainError> {
    let host = WideHostRef::from_bytes(&b[off::HOST..off::HOST + HOST_REF_LEN])
        .map_err(WidePlainError::Host)?;
    let dest = ProvinceKey::from_bytes(&b[off::DEST..off::DEST + PROVINCE_KEY_LEN])
        .map_err(WidePlainError::Dest)?;
    let mut path = [0u8; ks::PATH_BYTES];
    path.copy_from_slice(&b[off::PATH..off::PATH + ks::PATH_BYTES]);
    let mut reserved = [0u8; WIDE_RESERVED_BYTES];
    reserved.copy_from_slice(&b[off::RESERVED..]);
    Ok(WidePlain {
        version: b[off::VERSION],
        host,
        arrive_bell: u32::from_le_bytes([
            b[off::ARRIVE_BELL],
            b[off::ARRIVE_BELL + 1],
            b[off::ARRIVE_BELL + 2],
            b[off::ARRIVE_BELL + 3],
        ]),
        dest,
        dest_tile: b[off::DEST_TILE],
        stance: b[off::STANCE],
        retreat_bps: u16::from_le_bytes([b[off::RETREAT_BPS], b[off::RETREAT_BPS + 1]]),
        path_len: b[off::PATH_LEN],
        path,
        reserved,
    })
}

/// Checks a plaintext against its transit, the deployed `seal::validate`
/// over the wide fields: version 2, reserved zero, the committed host the
/// transit's full reference (`HostMismatch`; the host codec is strict, so
/// no camp or keep identity can be a plaintext's host), the arrival bell
/// the transit's, the destination in the host's world (`WorldMismatch`),
/// `path_len ≤ 32`, no bit set above the last step, every step a real
/// direction (0..6), the tile inside the province, a known stance,
/// `retreat_bps ≤ 60,000`.
pub fn validate(
    pt: &WidePlain,
    host: &WideHostRef,
    arrive_bell: u32,
) -> Result<(), WidePlainError> {
    if pt.version != WIDE_PLAIN_VERSION {
        return Err(WidePlainError::Version);
    }
    if pt.reserved != [0; WIDE_RESERVED_BYTES] {
        return Err(WidePlainError::Reserved);
    }
    if pt.host != *host {
        return Err(WidePlainError::HostMismatch);
    }
    if pt.arrive_bell != arrive_bell {
        return Err(WidePlainError::ArriveMismatch);
    }
    if pt.dest.world() != pt.host.key().world() {
        return Err(WidePlainError::WorldMismatch);
    }
    let n = pt.path_len as usize;
    if n > MAX_PATH_STEPS {
        return Err(WidePlainError::PathTooLong);
    }
    let used = 3 * n;
    for (i, &byte) in pt.path.iter().enumerate() {
        let lo = 8 * i;
        let keep = if used >= lo + 8 {
            0xffu8
        } else if used <= lo {
            0
        } else {
            (1u8 << (used - lo)) - 1
        };
        if byte & !keep != 0 {
            return Err(WidePlainError::PathBits);
        }
    }
    if (0..n).any(|i| ks::path_step(&pt.path, i) >= 6) {
        return Err(WidePlainError::Direction);
    }
    if pt.dest_tile as usize >= PROVINCE_TILES {
        return Err(WidePlainError::Tile);
    }
    if pt.stance > ks::STANCE_MAX {
        return Err(WidePlainError::Stance);
    }
    if pt.retreat_bps > ks::RETREAT_MAX_BPS {
        return Err(WidePlainError::Retreat);
    }
    Ok(())
}

/// `commit = sha256("PS-FRONTIER-MARCH-WIDE-v1" ‖ plain136 ‖ salt)`.
pub fn commit(pt: &[u8; WIDE_PLAIN_LEN], salt: &[u8; 32]) -> [u8; 32] {
    ks::commit_slice(DOMAIN_MARCH_WIDE, pt, salt)
}

/// `ct_hash = sha256(seal)` over the 264 bytes.
pub fn ct_hash(seal: &[u8; WIDE_SEAL_LEN]) -> [u8; 32] {
    sha256(&[seal])
}

/// `seal_root = sha256(commit ‖ ct_hash)`, the deployed shape.
pub fn seal_root(commit: &[u8; 32], ct_hash: &[u8; 32]) -> [u8; 32] {
    ks::seal_root(commit, ct_hash)
}

/// The 136-byte body XOR the deployed keystream of `k` (an involution).
pub fn body_xor(k: &[u8; ks::K_LEN], pt: &[u8; WIDE_PLAIN_LEN]) -> [u8; WIDE_PLAIN_LEN] {
    // 136 bytes are five blocks of the 256 the keystream covers (asserted
    // at compile time), so the length refusal cannot fire here.
    const _: () = assert!(WIDE_PLAIN_LEN <= ks::MAX_KEYSTREAM_LEN);
    let mut out = *pt;
    let _ = ks::keystream_xor(k, &mut out);
    out
}

/// The IBE block of a wide seal: the deployed opener's input, unchanged.
pub fn ibe_block(seal: &[u8; WIDE_SEAL_LEN]) -> [u8; IBE_LEN] {
    let mut b = [0u8; IBE_LEN];
    b.copy_from_slice(&seal[..IBE_LEN]);
    b
}

/// The body of a wide seal.
pub fn seal_body(seal: &[u8; WIDE_SEAL_LEN]) -> [u8; WIDE_PLAIN_LEN] {
    let mut b = [0u8; WIDE_PLAIN_LEN];
    b.copy_from_slice(&seal[IBE_LEN..]);
    b
}

/// A seal from its IBE block and a sealed body (what a sealer assembles;
/// the IBE block is tlock's, produced off chain).
pub fn assemble(ibe: &[u8; IBE_LEN], body: &[u8; WIDE_PLAIN_LEN]) -> [u8; WIDE_SEAL_LEN] {
    let mut s = [0u8; WIDE_SEAL_LEN];
    s[..IBE_LEN].copy_from_slice(ibe);
    s[IBE_LEN..].copy_from_slice(body);
    s
}

/// Opens the body with a key `k` recovered from the IBE block and checks
/// the commitment: `Some(plain)` iff `commit(plain, salt_of(k)) ==
/// commitment` (the pairing and the FO check are the program opener's).
pub fn open_body(
    k: &[u8; ks::K_LEN],
    seal: &[u8; WIDE_SEAL_LEN],
    commitment: &[u8; 32],
) -> Option<[u8; WIDE_PLAIN_LEN]> {
    let pt = body_xor(k, &seal_body(seal));
    (commit(&pt, &ks::salt_of(k)) == *commitment).then_some(pt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WideCoord;
    use crate::world_index::key::WorldId;

    fn world() -> WorldId {
        WorldId::new([0x77; 32]).unwrap()
    }

    fn key(p: i64, q: i64) -> ProvinceKey {
        ProvinceKey::new(world(), WideCoord::checked(p, q).unwrap())
    }

    fn host() -> WideHostRef {
        WideHostRef::new(key(129, 0), 3, 1, 7).unwrap()
    }

    fn sample() -> WidePlain {
        let (n, path) = ks::encode_path(&[0, 1, 2, 3, 4, 5, 0, 5]).unwrap();
        WidePlain {
            version: WIDE_PLAIN_VERSION,
            host: host(),
            arrive_bell: 500,
            dest: key(130, -1),
            dest_tile: 60,
            stance: 2,
            retreat_bps: 0,
            path_len: n,
            path,
            reserved: [0; WIDE_RESERVED_BYTES],
        }
    }

    #[test]
    fn layout_is_136_bytes_and_the_seal_264() {
        assert_eq!(WIDE_PLAIN_LEN, 136);
        assert_eq!(WIDE_SEAL_LEN, 264);
        assert_eq!(IBE_LEN, 128);
        assert_eq!(off::RESERVED, 128);
        assert_eq!(off::PATH, 116);
        assert_eq!(off::DEST_TILE, 111);
        assert_ne!(WIDE_PLAIN_VERSION, ks::PLAIN_VERSION);
        assert_ne!(DOMAIN_MARCH_WIDE, ks::DOMAIN_MARCH);
    }

    #[test]
    fn pack_round_trips_and_refuses_undecodable_identities() {
        let pt = sample();
        let b = pack(&pt);
        assert_eq!(b[0], 2);
        assert_eq!(&b[off::HOST..off::HOST + HOST_REF_LEN], &host().to_bytes());
        assert_eq!(unpack(&b), Ok(pt));
        // a zero world in the host or the destination does not decode
        let mut x = b;
        x[off::HOST + 1..off::HOST + 33].fill(0);
        assert_eq!(
            unpack(&x),
            Err(WidePlainError::Host(KeyError::ReservedWorld))
        );
        let mut x = b;
        x[off::DEST + 1..off::DEST + 33].fill(0);
        assert_eq!(
            unpack(&x),
            Err(WidePlainError::Dest(KeyError::ReservedWorld))
        );
        let mut x = b;
        x[off::DEST] = 9;
        assert!(matches!(unpack(&x), Err(WidePlainError::Dest(_))));
    }

    #[test]
    fn validate_refuses_each_field() {
        let ok = sample();
        assert_eq!(validate(&ok, &host(), 500), Ok(()));
        let e = |f: &dyn Fn(&mut WidePlain)| {
            let mut p = ok;
            f(&mut p);
            validate(&p, &host(), 500)
        };
        assert_eq!(e(&|p| p.version = 1), Err(WidePlainError::Version));
        assert_eq!(e(&|p| p.reserved[7] = 1), Err(WidePlainError::Reserved));
        assert_eq!(
            e(&|p| p.host = WideHostRef::new(key(129, 0), 3, 1, 8).unwrap()),
            Err(WidePlainError::HostMismatch)
        );
        assert_eq!(
            e(&|p| p.arrive_bell = 501),
            Err(WidePlainError::ArriveMismatch)
        );
        assert_eq!(
            e(&|p| p.dest = ProvinceKey::new(
                WorldId::new([0x78; 32]).unwrap(),
                WideCoord::checked(130, -1).unwrap()
            )),
            Err(WidePlainError::WorldMismatch)
        );
        assert_eq!(e(&|p| p.path_len = 33), Err(WidePlainError::PathTooLong));
        assert_eq!(e(&|p| p.path_len = 7), Err(WidePlainError::PathBits));
        assert_eq!(e(&|p| p.path[11] = 0x80), Err(WidePlainError::PathBits));
        assert_eq!(
            e(&|p| ks::set_path_step(&mut p.path, 1, 7)),
            Err(WidePlainError::Direction)
        );
        assert_eq!(e(&|p| p.dest_tile = 61), Err(WidePlainError::Tile));
        assert_eq!(e(&|p| p.stance = 4), Err(WidePlainError::Stance));
        assert_eq!(e(&|p| p.retreat_bps = 60_001), Err(WidePlainError::Retreat));
        assert_eq!(e(&|p| p.retreat_bps = 60_000), Ok(()));
        // a destination in the legacy disk is a valid plaintext: the
        // boundary is the reveal's to refuse, by the standing roster
        assert_eq!(e(&|p| p.dest = key(3, -1)), Ok(()));
    }

    /// The body opens under the deployed keystream and the wide
    /// commitment; a wrong key or commitment does not; the legacy 37-byte
    /// commitment of the same bytes is another value.
    #[test]
    fn body_xor_is_an_involution_and_opens_under_the_wide_commitment() {
        let k = [0x42u8; 16];
        let pt = pack(&sample());
        let body = body_xor(&k, &pt);
        assert_ne!(body, pt);
        assert_eq!(body_xor(&k, &body), pt);
        // the first 37 bytes of the body are the legacy body of the same
        // 37 plaintext bytes: the same two keystream blocks
        let mut head = [0u8; ks::PLAIN_LEN];
        head.copy_from_slice(&pt[..ks::PLAIN_LEN]);
        assert_eq!(&body[..ks::PLAIN_LEN], &ks::body_xor(&k, &head)[..]);
        let ibe = [0x11u8; IBE_LEN];
        let seal = assemble(&ibe, &body);
        assert_eq!(ibe_block(&seal), ibe);
        assert_eq!(seal_body(&seal), body);
        let c = commit(&pt, &ks::salt_of(&k));
        assert_eq!(open_body(&k, &seal, &c), Some(pt));
        assert_eq!(open_body(&[0u8; 16], &seal, &c), None);
        assert_eq!(open_body(&k, &seal, &[0u8; 32]), None);
        assert_ne!(
            c,
            ks::commit_slice(ks::DOMAIN_MARCH, &pt, &ks::salt_of(&k)),
            "the wide domain"
        );
        let root = seal_root(&c, &ct_hash(&seal));
        assert_eq!(root, sha256(&[&c, &sha256(&[&seal])]));
    }
}
