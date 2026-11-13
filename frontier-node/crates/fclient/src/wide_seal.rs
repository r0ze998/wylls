//! **Experimental** (`wide-records-experimental`): a real 264-byte **wide
//! march seal**, sealed exactly as `frontier_abi::world_index::seal`
//! defines it, and opened with the stock opener.
//!
//! `seal_wide` checks the plaintext with the ABI's own `validate` against the
//! transit's host and arrival bell, draws a fresh random 16-byte key `k`
//! (OS RNG, memory only), encrypts `k` to the round with the stock
//! `tlock::encrypt` (the same compact-16 IBE block as the legacy seal, its
//! Fujisaki–Okamoto randomness drawn inside the crate), XORs the packed
//! 136-byte plaintext with the ABI's keystream of `k` and assembles
//! `IBE ‖ body` with the ABI's helpers. `commit`, `ct_hash` and `seal_root`
//! are the ABI's functions; nothing is re-derived here.
//!
//! **What leaves, what does not.** The caller gets the seal, commitment,
//! `ct_hash` and `seal_root` (what Depart carries), plus a [`WideReveal`]
//! holding the packed plaintext and salt that a later Reveal instruction
//! carries (`wide_ix::ExpeditionReveal { plain, salt, ct_hash, .. }`). `k`
//! itself is never returned: the program recovers it from the beacon
//! signature. `k` is overwritten before return, and [`WideReveal`] is
//! overwritten on drop (best effort: no new dependency such as `zeroize`;
//! copies the optimiser makes are not covered). Nothing here writes a file,
//! logs or serialises a key, salt or plaintext; `WideReveal`'s `Debug` is
//! redacted.
//!
//! [`open_wide`] is the off-chain judge: the stock `seal::open_ibe` (real
//! pairing and FO check), then the ABI's `open_body` (commitment) and
//! `unpack` + `validate` (host, arrival, destination world, path, tile...).
//!
//! The legacy 165-byte seal and its 37-byte plaintext ([`crate::seal`]) are
//! untouched.
//!
//! **Tests use a past, already published Quicknet round** and its real
//! signature: they prove the encryption, opening and commitment are
//! consistent, *not* that a seal stays secret until a future round.
use frontier_abi::world_index::key::WideHostRef;
use frontier_abi::world_index::seal::{
    self as ws, WidePlain, WidePlainError, IBE_LEN, WIDE_PLAIN_LEN, WIDE_SEAL_LEN,
};
use permutation_rules::frontier::seal as ks;

/// The secret half of a sealed march: what a Reveal carries after arrival.
/// Memory only; redacted `Debug`; overwritten on drop.
pub struct WideReveal {
    plain: [u8; WIDE_PLAIN_LEN],
    salt: [u8; 32],
}
impl WideReveal {
    /// The packed 136-byte plaintext (`ExpeditionReveal::plain`).
    pub fn plain(&self) -> &[u8; WIDE_PLAIN_LEN] {
        &self.plain
    }
    /// `salt = sha256("PS-SALT" ‖ k)` (`ExpeditionReveal::salt`).
    pub fn salt(&self) -> &[u8; 32] {
        &self.salt
    }
}
impl core::fmt::Debug for WideReveal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("WideReveal(<redacted>)")
    }
}
impl Drop for WideReveal {
    fn drop(&mut self) {
        wipe(&mut self.plain);
        wipe(&mut self.salt);
    }
}

/// A sealed wide march: the public part Depart carries, and the reveal.
#[derive(Debug)]
pub struct WideSealed {
    pub seal: [u8; WIDE_SEAL_LEN],
    pub commit: [u8; 32],
    pub ct_hash: [u8; 32],
    pub seal_root: [u8; 32],
    pub reveal: WideReveal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WideSealError {
    /// The plaintext is not this transit's (the ABI's `validate`).
    Plain(WidePlainError),
    /// The stock tlock encryption failed or produced another length.
    Encrypt(String),
}

/// Why a wide seal does not open to a valid plaintext.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideOpenError {
    /// The stock opener refused the IBE block (bad point / FO check,
    /// including another round's signature).
    Ibe(crate::seal::OpenError),
    /// Opened, but the commitment does not match.
    Commit,
    /// Opened and committed, but the plaintext is not this transit's.
    Plain(WidePlainError),
}

fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: a valid, aligned, exclusively borrowed byte.
        unsafe { core::ptr::write_volatile(x, 0) };
    }
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
}

/// Seals `pt` for the transit `(host, arrive_bell)` to `round` under the
/// beacon key `pk96`, with a fresh random key.
pub fn seal_wide(
    pt: &WidePlain,
    host: &WideHostRef,
    arrive_bell: u32,
    pk96: &[u8; 96],
    round: u64,
) -> Result<WideSealed, WideSealError> {
    ws::validate(pt, host, arrive_bell).map_err(WideSealError::Plain)?;
    let mut k = crate::seal::random_key();
    let out = seal_with(pt, pk96, round, &k);
    wipe(&mut k);
    out
}

fn seal_with(
    pt: &WidePlain,
    pk96: &[u8; 96],
    round: u64,
    k: &[u8; ks::K_LEN],
) -> Result<WideSealed, WideSealError> {
    let mut ibe = Vec::with_capacity(IBE_LEN);
    tlock::encrypt(&mut ibe, &k[..], pk96, round).map_err(|e| WideSealError::Encrypt(e.to_string()))?;
    let ibe: [u8; IBE_LEN] = ibe
        .as_slice()
        .try_into()
        .map_err(|_| WideSealError::Encrypt(format!("tlock produced {} B, want {IBE_LEN}", ibe.len())))?;
    let reveal = WideReveal { plain: ws::pack(pt), salt: ks::salt_of(k) };
    let seal = ws::assemble(&ibe, &ws::body_xor(k, &reveal.plain));
    let commit = ws::commit(&reveal.plain, &reveal.salt);
    let ct_hash = ws::ct_hash(&seal);
    Ok(WideSealed { seal, commit, ct_hash, seal_root: ws::seal_root(&commit, &ct_hash), reveal })
}

/// Opens a wide seal with the round's signature and judges it against the
/// logged commitment and the transit.
pub fn open_wide(
    seal: &[u8; WIDE_SEAL_LEN],
    sig48: &[u8; 48],
    commitment: &[u8; 32],
    host: &WideHostRef,
    arrive_bell: u32,
) -> Result<WidePlain, WideOpenError> {
    let mut k = crate::seal::open_ibe(&ws::ibe_block(seal), sig48).map_err(WideOpenError::Ibe)?;
    let opened = ws::open_body(&k, seal, commitment);
    wipe(&mut k);
    let pt = opened.ok_or(WideOpenError::Commit)?;
    let p = ws::unpack(&pt).map_err(WideOpenError::Plain)?;
    ws::validate(&p, host, arrive_bell).map_err(WideOpenError::Plain)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    //! Real tlock over the real Quicknet key, opened with the real published
    //! signature of a past round (`fixtures/tlock/q4-vector.json`). This is
    //! cryptographic consistency only, never future secrecy. No test beacon,
    //! fixed key or reused IBE block makes anything pass here.
    use super::*;
    use crate::beacon::{quicknet_info, verify};
    use crate::seal::OpenError;
    use frontier_abi::world_index::{ProvinceKey, WideCoord, WorldId};

    struct Round {
        round: u64,
        sig: [u8; 48],
        prev: [u8; 48],
        pk: [u8; 96],
    }
    fn published() -> Round {
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(crate::seal::fixture_dir().join("q4-vector.json")).unwrap(),
        )
        .unwrap();
        let hx = |k: &str| hex::decode(v[k].as_str().unwrap()).unwrap();
        let r = Round {
            round: v["round"].as_u64().unwrap(),
            sig: hx("sig").try_into().unwrap(),
            prev: hx("prev_round_sig").try_into().unwrap(),
            pk: quicknet_info().public_key,
        };
        // the real Quicknet signature of that round under the real key
        assert!(verify(r.round, &r.sig, &r.pk));
        r
    }
    fn key(p: i64, q: i64) -> ProvinceKey {
        ProvinceKey::new(WorldId::new([0x77; 32]).unwrap(), WideCoord::checked(p, q).unwrap())
    }
    fn host() -> WideHostRef {
        WideHostRef::new(key(129, 0), 3, 1, 7).unwrap()
    }
    fn plain() -> WidePlain {
        let (path_len, path) = ks::encode_path(&[0, 1, 2]).unwrap();
        WidePlain {
            version: ws::WIDE_PLAIN_VERSION,
            host: host(),
            arrive_bell: 500,
            dest: key(130, -1),
            dest_tile: 30,
            stance: 1,
            retreat_bps: 2_500,
            path_len,
            path,
            reserved: [0; ws::WIDE_RESERVED_BYTES],
        }
    }

    #[test]
    fn a_real_wide_seal_opens_with_the_published_signature_and_feeds_reveal() {
        let r = published();
        let s = seal_wide(&plain(), &host(), 500, &r.pk, r.round).unwrap();
        assert_eq!(s.seal.len(), 264);
        // Depart's seal-flag syntax: a compressed, non-infinity G2 point
        assert!(s.seal[0] & 0x80 != 0 && s.seal[0] & 0x40 == 0);
        // real pairing + FO check through the stock opener, then the ABI body
        assert_eq!(open_wide(&s.seal, &r.sig, &s.commit, &host(), 500), Ok(plain()));
        // secret comparisons are boolean with fixed messages: a failure never
        // prints k, the salt or the plaintext
        let mut k = crate::seal::open_ibe(&ws::ibe_block(&s.seal), &r.sig).unwrap();
        assert!(ks::salt_of(&k) == *s.reveal.salt(), "the opened key's salt is not the sealed salt");
        assert!(
            ws::open_body(&k, &s.seal, &s.commit).is_some_and(|pt| pt == *s.reveal.plain()),
            "the opened body is not the sealed plaintext"
        );
        wipe(&mut k);
        // the public values are the ABI's functions of the seal
        assert_eq!(s.ct_hash, ws::ct_hash(&s.seal));
        assert_eq!(s.seal_root, ws::seal_root(&s.commit, &s.ct_hash));
        assert_eq!(ws::commit(s.reveal.plain(), s.reveal.salt()), s.commit);
        // what a Reveal carries encodes with these exact bytes
        let rev = frontier_abi::world_index::wide_ix::ExpeditionReveal {
            transit_slot: 0,
            target_i: 0,
            plain: *s.reveal.plain(),
            salt: *s.reveal.salt(),
            ct_hash: s.ct_hash,
            beneficiary: [9; 32],
        };
        assert_eq!(rev.to_bytes().len(), frontier_abi::world_index::wide_ix::ExpeditionReveal::LEN);
        assert_eq!(format!("{:?}", s.reveal), "WideReveal(<redacted>)");
    }

    #[test]
    fn each_seal_draws_a_fresh_key() {
        let r = published();
        let a = seal_wide(&plain(), &host(), 500, &r.pk, r.round).unwrap();
        let b = seal_wide(&plain(), &host(), 500, &r.pk, r.round).unwrap();
        assert_ne!(a.seal[..IBE_LEN], b.seal[..IBE_LEN]);
        assert_ne!(a.seal[IBE_LEN..], b.seal[IBE_LEN..]);
        assert!(a.reveal.salt() != b.reveal.salt(), "two seals share a salt");
        assert_ne!(a.commit, b.commit);
    }

    #[test]
    fn refusals_are_exact() {
        let r = published();
        // a plaintext that is not the transit's is never encrypted
        let other = WideHostRef::new(key(129, 0), 3, 1, 8).unwrap();
        assert_eq!(seal_wide(&plain(), &other, 500, &r.pk, r.round).err(), Some(WideSealError::Plain(WidePlainError::HostMismatch)));
        assert_eq!(seal_wide(&plain(), &host(), 501, &r.pk, r.round).err(), Some(WideSealError::Plain(WidePlainError::ArriveMismatch)));
        let mut far = plain();
        far.dest = ProvinceKey::new(WorldId::new([0x78; 32]).unwrap(), WideCoord::checked(130, -1).unwrap());
        assert_eq!(seal_wide(&far, &host(), 500, &r.pk, r.round).err(), Some(WideSealError::Plain(WidePlainError::WorldMismatch)));
        let s = seal_wide(&plain(), &host(), 500, &r.pk, r.round).unwrap();
        // another round's real signature: FO check
        assert_eq!(open_wide(&s.seal, &r.prev, &s.commit, &host(), 500), Err(WideOpenError::Ibe(OpenError::FoCheck)));
        // a sealed-to-another-round seal does not open with this signature
        let later = seal_wide(&plain(), &host(), 500, &r.pk, r.round + 1).unwrap();
        assert!(matches!(open_wide(&later.seal, &r.sig, &later.commit, &host(), 500), Err(WideOpenError::Ibe(_))));
        // a body byte flipped: opens, but the commitment no longer matches
        let mut body = s.seal;
        body[IBE_LEN + 70] ^= 1;
        assert_eq!(open_wide(&body, &r.sig, &s.commit, &host(), 500), Err(WideOpenError::Commit));
        // a garbage U
        let mut u = s.seal;
        u[..96].fill(0xab);
        assert!(matches!(open_wide(&u, &r.sig, &s.commit, &host(), 500), Err(WideOpenError::Ibe(_))));
        // another logged commitment
        assert_eq!(open_wide(&s.seal, &r.sig, &[0; 32], &host(), 500), Err(WideOpenError::Commit));
        // opened correctly, judged against another transit
        assert_eq!(open_wide(&s.seal, &r.sig, &s.commit, &other, 500), Err(WideOpenError::Plain(WidePlainError::HostMismatch)));
        assert_eq!(open_wide(&s.seal, &r.sig, &s.commit, &host(), 499), Err(WideOpenError::Plain(WidePlainError::ArriveMismatch)));
    }
}
