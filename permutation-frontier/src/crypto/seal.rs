//! The on-chain tlock opener (S-TLOCK-V, SP-V2 `seal.rs`): opens a compact-16
//! quicknet seal with the round-T(arrive) signature THE anchor (or, once
//! archived, the archive entry) stores, runs the Fujisaki–Okamoto check and
//! judges the result with the contract's seal codes (§5.3 SealVerdict note,
//! I-44). SettleTransit (W4-B) calls [`judge`]; it is here, with the rest of
//! the crypto port, so the wave-2 build already carries and measures it.
//!
//! Seal (165 B): `U (96, compressed G2) ‖ V (16) ‖ W (16) ‖ body (37)`.
//! With `s` = the round signature (G1): `sigma = V ⊕ H2(e(s, U))`, `k = W ⊕
//! H4(sigma)`, FO check `U == H3(sigma, k) · G2`, then the body opens with
//! `k` (`seal::body_xor`) and must hash to the logged commitment under
//! `salt_of(k)` (I-06). The hash domains and the FO scalar derivation are
//! tlock 0.0.10's, unchanged from SP-V2 (measured against stock tlock
//! there and in `seal-vectors-v1.json`).
//!
//! **Codes:** 0 valid, 1 FO check failed, 2 bad point / not in the
//! subgroup, 3 wrong round, 4 commitment mismatch after opening, 5
//! plaintext invalid (`seal::validate`, I-28). A seal sealed to another
//! round cannot be told apart from a tampered one: the pairing with the
//! wrong signature yields a random `sigma` and the FO check fails, so it is
//! judged 1 (the `wrong_round` vector expects `fo_fail`); code 3 is kept in
//! the table for a future opener that can prove the round.

use permutation_rules::frontier::seal as kseal;

use super::{sys, xmd::sha256};
use frontier_abi::log::seal_code;
#[cfg(feature = "wide-world-experimental")]
use frontier_abi::world_index::seal as wseal;

/// Compact-16 seal length.
pub const SEAL_LEN: usize = kseal::SEAL_LEN;
const N: usize = kseal::K_LEN;
const U: usize = kseal::SEAL_U;
const V: usize = kseal::SEAL_V;
const W: usize = kseal::SEAL_W;

// BLS12-381 G2 generator, uncompressed Zcash BE (x.c1, x.c0, y.c1, y.c0).
const G2_GEN: [u8; 192] = hex192(
    b"13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e\
024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8\
0606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be\
0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801",
);
// r = BLS12-381 scalar field order, big-endian.
const R_ORDER: [u8; 32] =
    super::quick::hex32(b"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001");

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => 0,
    }
}

const fn hex192(s: &[u8]) -> [u8; 192] {
    let mut o = [0u8; 192];
    let mut i = 0;
    while i < 192 {
        o[i] = (nib(s[2 * i]) << 4) | nib(s[2 * i + 1]);
        i += 1;
    }
    o
}

/// The IBE block every seal shape starts with: `U ‖ V ‖ W`, 128 bytes.
pub const IBE_LEN: usize = kseal::SEAL_BODY;

/// Recovers the seal key `k` from the IBE block `ibe` (the first 128 bytes
/// of a seal of any body length) with the round signature `s_aff`
/// (uncompressed G1, 96 B): the pairing, `sigma`, `k`, the FO check. The
/// steps and their order are the opener's of before, byte for byte; the
/// body is the caller's (37 bytes: [`open`]; 136 bytes: the wide opener).
/// `Err` is the seal code (1 or 2).
#[inline(never)]
pub fn recover_key(s_aff: &[u8; 96], ibe: &[u8; IBE_LEN]) -> Result<[u8; N], u8> {
    let mut u = [0u8; 96];
    u.copy_from_slice(&ibe[U..U + 96]);
    let Some(u_aff) = sys::bls_g2_decompress(&u) else {
        return Err(seal_code::BAD_POINT);
    };
    crate::heap::trace_checkpoint(31);
    let mut gt = [0u8; 576];
    if sys::bls_pairing(s_aff, &u_aff, 1, &mut gt).is_err() {
        return Err(seal_code::BAD_POINT);
    }
    crate::heap::trace_checkpoint(32);
    let h2 = sha256(&[b"IBE-H2", &gt]);
    let mut sigma = [0u8; N];
    for i in 0..N {
        sigma[i] = ibe[V + i] ^ h2[i];
    }
    let h4 = sha256(&[b"IBE-H4", &sigma]);
    let mut k = [0u8; N];
    for i in 0..N {
        k[i] = ibe[W + i] ^ h4[i];
    }
    // FO check: U == H3(sigma, k) · G2.
    let h3 = sha256(&[b"IBE-H3", &sigma, &k]);
    let mut r = [0u8; 32];
    let mut ok = false;
    for i in 1u16..u16::MAX {
        r = sha256(&[&i.to_le_bytes(), &h3]);
        r[0] >>= 1;
        if r < R_ORDER {
            ok = true;
            break;
        }
    }
    if !ok {
        return Err(seal_code::FO_FAILED);
    }
    let Some(rp) = sys::bls_g2_mul(&r, &G2_GEN) else {
        return Err(seal_code::FO_FAILED);
    };
    if rp != u_aff {
        return Err(seal_code::FO_FAILED);
    }
    crate::heap::trace_checkpoint(33);
    Ok(k)
}

/// Opens `seal` with the round signature `s_aff` (uncompressed G1, 96 B)
/// and checks the body against `commit`. `Ok(plain)` when the seal opens
/// and the opened body hashes to `commit`; otherwise the seal code (1, 2
/// or 4).
#[inline(never)]
pub fn open(s_aff: &[u8; 96], seal: &[u8; SEAL_LEN], commit: &[u8; 32]) -> Result<[u8; 37], u8> {
    let mut ibe = [0u8; IBE_LEN];
    ibe.copy_from_slice(&seal[..IBE_LEN]);
    let k = recover_key(s_aff, &ibe)?;
    kseal::open_body(&k, seal, commit).ok_or(seal_code::COMMIT_MISMATCH)
}

/// The wide opener (experimental, host-only build): the deployed key
/// recovery over the seal's IBE block, then the 136-byte body under the
/// wide commitment (`world_index::seal`). The same codes.
#[cfg(feature = "wide-world-experimental")]
pub fn open_wide(
    s_aff: &[u8; 96],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
    commit: &[u8; 32],
) -> Result<[u8; wseal::WIDE_PLAIN_LEN], u8> {
    let k = recover_key(s_aff, &wseal::ibe_block(seal))?;
    wseal::open_body(&k, seal, commit).ok_or(seal_code::COMMIT_MISMATCH)
}

/// The wide verdict: the seal code and, for code 0, the wide plaintext,
/// judged against the transit's full host reference and arrival bell
/// (`world_index::seal::validate`: the host, the bell, the destination's
/// world, the path, the tile, the stance and the retreat ratio are all
/// inside the commitment; nothing is read beside it). A plaintext whose
/// host or destination bytes do not decode is code 5, as an invalid
/// plaintext.
#[cfg(feature = "wide-world-experimental")]
pub fn judge_wide(
    s_aff: &[u8; 96],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
    commit: &[u8; 32],
    host: &frontier_abi::world_index::WideHostRef,
    arrive_bell: u32,
) -> (u8, Option<wseal::WidePlain>) {
    match open_wide(s_aff, seal, commit) {
        Err(code) => (code, None),
        Ok(pt) => match wseal::unpack(&pt) {
            Ok(plain) if wseal::validate(&plain, host, arrive_bell).is_ok() => {
                (seal_code::VALID, Some(plain))
            }
            _ => (seal_code::BAD_PLAINTEXT, None),
        },
    }
}

/// `seal_root = sha256(commit ‖ sha256(seal))` over a wide seal.
#[cfg(feature = "wide-world-experimental")]
pub fn wide_seal_root_of(commit: &[u8; 32], seal: &[u8; wseal::WIDE_SEAL_LEN]) -> [u8; 32] {
    wseal::seal_root(commit, &wseal::ct_hash(seal))
}

/// The verdict SettleTransit logs: the seal code and, for code 0, the
/// march's plaintext. `host_id` and `arrive_bell` are the transit's.
pub fn judge(
    s_aff: &[u8; 96],
    seal: &[u8; SEAL_LEN],
    commit: &[u8; 32],
    host_id: u64,
    arrive_bell: u32,
) -> (u8, Option<kseal::Plain>) {
    match open(s_aff, seal, commit) {
        Err(code) => (code, None),
        Ok(pt) => {
            let plain = kseal::unpack(&pt);
            match kseal::validate(&plain, host_id, arrive_bell) {
                Ok(()) => (seal_code::VALID, Some(plain)),
                Err(_) => (seal_code::BAD_PLAINTEXT, None),
            }
        }
    }
}

/// `seal_root = sha256(commit ‖ sha256(seal))` (Depart stores it;
/// SettleTransit checks the logged pair against it).
pub fn seal_root_of(commit: &[u8; 32], seal: &[u8; SEAL_LEN]) -> [u8; 32] {
    kseal::seal_root(commit, &kseal::ct_hash(seal))
}

/// The unit tests, and the public seal-vector readers (`cases`, `get`,
/// `hex`) the opt-in native dispatcher test of the wide march reuses.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn g2_generator_constant_is_arks() {
        use super::super::field::from_be;
        use ark_bls12_381::{Fq, Fq2, G2Affine};
        use ark_ec::AffineRepr;
        let f = |o: usize| from_be::<Fq, 6>(&G2_GEN[o..o + 48]).unwrap();
        let g = G2Affine::new_unchecked(Fq2::new(f(48), f(0)), Fq2::new(f(144), f(96)));
        assert_eq!(g, G2Affine::generator());
    }

    #[test]
    fn host_opening_is_a_bad_point() {
        // No G2 decompression syscall on the host: every seal is code 2
        // there, never "valid".
        assert_eq!(
            judge(&[0; 96], &[0; SEAL_LEN], &[0; 32], 1, 2),
            (seal_code::BAD_POINT, None)
        );
    }

    #[test]
    fn seal_root_is_the_kernels() {
        let seal = [5u8; SEAL_LEN];
        let c = [6u8; 32];
        assert_eq!(seal_root_of(&c, &seal), sha256(&[&c, &sha256(&[&seal])]));
    }

    pub(crate) fn hex(s: &str) -> alloc::vec::Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The cases of `permutation-rules/vectors/seal-vectors-v1.json` as
    /// (key, value) lists (the file is pretty-printed one field per line).
    pub(crate) fn cases(
    ) -> alloc::vec::Vec<alloc::vec::Vec<(alloc::string::String, alloc::string::String)>> {
        cases_in(include_str!(
            "../../../permutation-rules/vectors/seal-vectors-v1.json"
        ))
    }

    /// [`cases`] over any vector file of the same shape (a `cases` array of
    /// flat objects, one string field per line): the wide settlement
    /// expectations the host dispatcher tests share with the keeper's.
    pub(crate) fn cases_in(
        text: &str,
    ) -> alloc::vec::Vec<alloc::vec::Vec<(alloc::string::String, alloc::string::String)>> {
        let mut out = alloc::vec::Vec::new();
        let mut cur: Option<alloc::vec::Vec<_>> = None;
        for line in text.lines() {
            let t = line.trim();
            if t == "{" && text.contains("\"cases\"") {
                cur = Some(alloc::vec::Vec::new());
                continue;
            }
            if t.starts_with('}') {
                if let Some(c) = cur.take() {
                    if !c.is_empty() {
                        out.push(c);
                    }
                }
                continue;
            }
            if let (Some(c), Some((k, v))) = (cur.as_mut(), t.split_once(": ")) {
                let k = k.trim_matches('"').into();
                let v = v.trim_end_matches(',').trim_matches('"').into();
                c.push((k, v));
            }
        }
        out
    }

    pub(crate) fn get<'a>(
        c: &'a [(alloc::string::String, alloc::string::String)],
        k: &str,
    ) -> &'a str {
        c.iter()
            .find(|(kk, _)| kk == k)
            .map(|(_, v)| v.as_str())
            .unwrap_or("null")
    }

    /// Everything of the opener except the pairing (the host has no
    /// syscall) against the W1-C seal vectors: `k = W ⊕ H4(sigma)`, the FO
    /// scalar `r = H3(sigma, k)` gives `r · G2 = U`, and the body opens to
    /// the vector's plaintext under the commitment (or does not, for the
    /// commitment-mismatch cases), with the vector's validation verdict.
    #[test]
    fn opener_steps_match_the_seal_vectors() {
        use ark_bls12_381::{Fr, G2Affine};
        use ark_ec::{AffineRepr, CurveGroup};
        use ark_ff::PrimeField;
        let mut checked = 0;
        for c in cases() {
            let sigma = get(&c, "sigma");
            if sigma == "null" || get(&c, "stock_tlock_opens") != "true" {
                continue;
            }
            let seal: [u8; SEAL_LEN] = hex(get(&c, "seal")).try_into().unwrap();
            let sigma: [u8; N] = hex(sigma).try_into().unwrap();
            let h4 = sha256(&[b"IBE-H4", &sigma]);
            let mut k = [0u8; N];
            for i in 0..N {
                k[i] = seal[W + i] ^ h4[i];
            }
            assert_eq!(k.to_vec(), hex(get(&c, "k")), "{}", get(&c, "name"));
            let h3 = sha256(&[b"IBE-H3", &sigma, &k]);
            let mut r = [0u8; 32];
            for i in 1u16..u16::MAX {
                r = sha256(&[&i.to_le_bytes(), &h3]);
                r[0] >>= 1;
                if r < R_ORDER {
                    break;
                }
            }
            let p = (G2Affine::generator() * Fr::from_be_bytes_mod_order(&r)).into_affine();
            let mut x = [0u8; 96];
            super::super::field::to_be::<ark_bls12_381::Fq, 6>(&p.x.c1, &mut x[..48]);
            super::super::field::to_be::<ark_bls12_381::Fq, 6>(&p.x.c0, &mut x[48..]);
            let mut ux = [0u8; 96];
            ux.copy_from_slice(&seal[..96]);
            ux[0] &= 0x1f;
            assert_eq!(x, ux, "{}: r·G2 = U", get(&c, "name"));
            let commit: [u8; 32] = hex(get(&c, "commit")).try_into().unwrap();
            let opened = kseal::open_body(&k, &seal, &commit);
            match get(&c, "expect") {
                "commit_mismatch" => assert_eq!(opened, None, "{}", get(&c, "name")),
                exp => {
                    let pt = opened.unwrap();
                    assert_eq!(pt.to_vec(), hex(get(&c, "plain")));
                    let host: u64 = get(&c, "host_id").parse().unwrap();
                    let arrive: u32 = get(&c, "arrive_bell").parse().unwrap();
                    let v = kseal::validate(&kseal::unpack(&pt), host, arrive);
                    assert_eq!(v.is_ok(), exp == "valid", "{}", get(&c, "name"));
                }
            }
            checked += 1;
        }
        assert_eq!(
            checked, 19,
            "every vector that stock tlock opens with a recorded sigma"
        );
    }

    /// The wide opener on the host: no G2 syscall, so every wide seal is
    /// code 2 there too, never "valid"; the root is the kernel's shape.
    #[cfg(feature = "wide-world-experimental")]
    #[test]
    fn host_opening_of_a_wide_seal_is_a_bad_point() {
        use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
        let k = ProvinceKey::new(
            WorldId::new([0x77; 32]).unwrap(),
            WideCoord::checked(129, 0).unwrap(),
        );
        let host = WideHostRef::new(k, 3, 1, 7).unwrap();
        assert_eq!(
            judge_wide(&[0; 96], &[0; wseal::WIDE_SEAL_LEN], &[0; 32], &host, 2),
            (seal_code::BAD_POINT, None)
        );
        let seal = [5u8; wseal::WIDE_SEAL_LEN];
        let c = [6u8; 32];
        assert_eq!(
            wide_seal_root_of(&c, &seal),
            sha256(&[&c, &sha256(&[&seal])])
        );
    }

    /// The wide body under the recorded seal vectors' keys, **without the
    /// pairing**: for every vector stock tlock opens, the recorded `k` is
    /// what the IBE block recovers (pinned above by
    /// `opener_steps_match_the_seal_vectors`); a wide plaintext sealed under
    /// that `k` behind the vector's unchanged IBE block opens to itself
    /// under the wide commitment and to nothing under the legacy one or a
    /// wrong key. This pins the wide body and commitment path; the pairing
    /// and the FO check are the legacy opener's code and are not re-tested
    /// here (the host has no syscall and no key is generated).
    #[cfg(feature = "wide-world-experimental")]
    #[test]
    fn wide_body_opens_under_the_vectors_recorded_keys() {
        use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
        let w = WorldId::new([0x77; 32]).unwrap();
        let key = |p: i64, q: i64| ProvinceKey::new(w, WideCoord::checked(p, q).unwrap());
        let host = WideHostRef::new(key(129, 0), 3, 1, 7).unwrap();
        let (n, path) = kseal::encode_path(&[0, 1, 2, 3, 4, 5, 0, 5]).unwrap();
        let mut checked = 0;
        for c in cases() {
            if get(&c, "sigma") == "null" || get(&c, "stock_tlock_opens") != "true" {
                continue;
            }
            let legacy_seal: [u8; SEAL_LEN] = hex(get(&c, "seal")).try_into().unwrap();
            let k: [u8; N] = hex(get(&c, "k")).try_into().unwrap();
            let arrive: u32 = get(&c, "arrive_bell").parse().unwrap();
            let plain = wseal::WidePlain {
                version: wseal::WIDE_PLAIN_VERSION,
                host,
                arrive_bell: arrive,
                dest: key(130, -1),
                dest_tile: 60,
                stance: 2,
                retreat_bps: 0,
                path_len: n,
                path,
                reserved: [0; wseal::WIDE_RESERVED_BYTES],
            };
            let pt = wseal::pack(&plain);
            let mut ibe = [0u8; wseal::IBE_LEN];
            ibe.copy_from_slice(&legacy_seal[..wseal::IBE_LEN]);
            let seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &pt));
            let commit = wseal::commit(&pt, &kseal::salt_of(&k));
            assert_eq!(wseal::open_body(&k, &seal, &commit), Some(pt));
            let opened = wseal::unpack(&wseal::open_body(&k, &seal, &commit).unwrap()).unwrap();
            assert_eq!(opened, plain);
            assert_eq!(wseal::validate(&opened, &host, arrive), Ok(()));
            // the legacy commitment of the vector never opens the wide body
            let legacy_commit: [u8; 32] = hex(get(&c, "commit")).try_into().unwrap();
            assert_eq!(wseal::open_body(&k, &seal, &legacy_commit), None);
            let mut wrong = k;
            wrong[0] ^= 1;
            assert_eq!(wseal::open_body(&wrong, &seal, &commit), None);
            // the IBE block is the vector's: the same `k` the legacy steps
            // recover (`opener_steps_match_the_seal_vectors`)
            assert_eq!(&seal[..wseal::IBE_LEN], &legacy_seal[..wseal::IBE_LEN]);
            checked += 1;
        }
        assert_eq!(checked, 19);
    }
    /// Reuse only public IBE/signature bytes; rebuild wide plaintext and commitment.
    #[cfg(all(
        feature = "native-crypto-tests",
        feature = "wide-world-experimental",
        not(target_os = "solana")
    ))]
    #[test]
    fn native_wide_seals_verify_real_pairing_fo_and_body() {
        use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
        let world = WorldId::new([0x77; 32]).unwrap();
        let key = |p, q| ProvinceKey::new(world, WideCoord::checked(p, q).unwrap());
        let host = WideHostRef::new(key(129, 0), 3, 1, 7).unwrap();
        let (path_len, path) = kseal::encode_path(&[0, 1, 2, 3, 4, 5, 0, 5]).unwrap();
        let fixtures = cases();
        for name in ["valid_q3", "valid_q4_min"] {
            let c = fixtures.iter().find(|c| get(c, "name") == name).unwrap();
            let legacy: [u8; SEAL_LEN] = hex(get(c, "seal")).try_into().unwrap();
            let ibe = legacy[..IBE_LEN].try_into().unwrap();
            let sig = sys::bls_g1_decompress(&hex(get(c, "open_sig")).try_into().unwrap()).unwrap();
            let k: [u8; N] = hex(get(c, "k")).try_into().unwrap();
            assert_eq!(
                recover_key(&sig, &ibe),
                Ok(k),
                "{name}: real pairing and FO"
            );
            let arrive = get(c, "arrive_bell").parse().unwrap();
            let plain = wseal::WidePlain {
                version: wseal::WIDE_PLAIN_VERSION,
                host,
                arrive_bell: arrive,
                dest: key(130, -1),
                dest_tile: 60,
                stance: 2,
                retreat_bps: 0,
                path_len,
                path,
                reserved: [0; wseal::WIDE_RESERVED_BYTES],
            };
            let pt = wseal::pack(&plain);
            let seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &pt));
            let commit = wseal::commit(&pt, &kseal::salt_of(&k));
            let root = wide_seal_root_of(&commit, &seal);
            assert_eq!(
                judge_wide(&sig, &seal, &commit, &host, arrive),
                (seal_code::VALID, Some(plain))
            );
            assert_ne!(root.to_vec(), hex(get(c, "seal_root")));
            let legacy_commit = hex(get(c, "commit")).try_into().unwrap();
            assert_eq!(
                open_wide(&sig, &seal, &legacy_commit),
                Err(seal_code::COMMIT_MISMATCH)
            );
            let mut bad = seal;
            bad[..96].fill(0);
            assert_eq!(open_wide(&sig, &bad, &commit), Err(seal_code::BAD_POINT));
            for offset in [V, W] {
                let mut bad = seal;
                bad[offset] ^= 1;
                assert_eq!(open_wide(&sig, &bad, &commit), Err(seal_code::FO_FAILED));
            }
            let mut bad = seal;
            bad[IBE_LEN] ^= 1;
            assert_eq!(
                open_wide(&sig, &bad, &commit),
                Err(seal_code::COMMIT_MISMATCH)
            );
            assert_ne!(wide_seal_root_of(&commit, &bad), root);
            assert_eq!(
                open_wide(&[0; 96], &seal, &commit),
                Err(seal_code::BAD_POINT)
            );
            let other = fixtures
                .iter()
                .find(|v| {
                    get(v, "name")
                        == if name == "valid_q3" {
                            "valid_q4_min"
                        } else {
                            "valid_q3"
                        }
                })
                .unwrap();
            let wrong_sig =
                sys::bls_g1_decompress(&hex(get(other, "open_sig")).try_into().unwrap()).unwrap();
            assert_eq!(
                open_wide(&wrong_sig, &seal, &commit),
                Err(seal_code::FO_FAILED)
            );
            assert_eq!(
                judge_wide(&sig, &seal, &commit, &host, arrive + 1),
                (seal_code::BAD_PLAINTEXT, None)
            );
            let wrong_host = WideHostRef::new(key(129, 0), 3, 1, 8).unwrap();
            assert_eq!(
                judge_wide(&sig, &seal, &commit, &wrong_host, arrive),
                (seal_code::BAD_PLAINTEXT, None)
            );
            let mut wrong_world = plain;
            wrong_world.dest = ProvinceKey::new(
                WorldId::new([0x78; 32]).unwrap(),
                WideCoord::checked(130, -1).unwrap(),
            );
            let invalid_pt = wseal::pack(&wrong_world);
            let invalid_seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &invalid_pt));
            let invalid_commit = wseal::commit(&invalid_pt, &kseal::salt_of(&k));
            assert_eq!(
                judge_wide(&sig, &invalid_seal, &invalid_commit, &host, arrive),
                (seal_code::BAD_PLAINTEXT, None)
            );
        }
    }

    // A real proof adapter must decompress these valid public signatures.
    // Keep this ordinary-stub expectation in every build without an adapter.
    #[cfg(not(any(feature = "native-crypto-tests", feature = "public-proof-tests")))]
    #[test]
    fn ordinary_host_refuses_even_public_valid_ibe() {
        for c in cases() {
            if get(&c, "name") != "valid_q3" && get(&c, "name") != "valid_q4_min" {
                continue;
            }
            let legacy: [u8; SEAL_LEN] = hex(get(&c, "seal")).try_into().unwrap();
            assert_eq!(
                recover_key(&[0; 96], &legacy[..IBE_LEN].try_into().unwrap()),
                Err(seal_code::BAD_POINT)
            );
            assert!(sys::bls_g1_decompress(&hex(get(&c, "open_sig")).try_into().unwrap()).is_err());
        }
    }
}
