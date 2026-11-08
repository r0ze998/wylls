//! Real SIMD-0388 math for opt-in native unit tests and local-march-demo.
//! Never linked into SBF. No signatures, keys or verdicts are mocked; this
//! module performs point operations and verification, not key generation.
use super::SysError;
use solana_bls12_381_syscall::{self as bls, Endianness::BE, Version::V0};

pub fn bls_g1_add(a: &[u8; 96], b: &[u8; 96]) -> Result<[u8; 96], SysError> {
    bls::bls12_381_g1_addition_unchecked(V0, &bls::PodG1Point(*a), &bls::PodG1Point(*b), BE)
        .map(|p| p.0)
        .ok_or(SysError::Syscall)
}
pub fn bls_g1_decompress(c: &[u8; 48]) -> Result<[u8; 96], SysError> {
    bls::bls12_381_g1_decompress(V0, &bls::PodG1Compressed(*c), BE)
        .map(|p| p.0)
        .ok_or(SysError::BadPoint)
}
pub fn bls_g2_decompress(c: &[u8; 96]) -> Option<[u8; 192]> {
    bls::bls12_381_g2_decompress(V0, &bls::PodG2Compressed(*c), BE).map(|p| p.0)
}
pub fn bls_g2_mul(scalar: &[u8; 32], p: &[u8; 192]) -> Option<[u8; 192]> {
    bls::bls12_381_g2_multiplication(V0, &bls::PodG2Point(*p), &bls::PodScalar(*scalar), BE)
        .map(|p| p.0)
}
pub fn bls_pairing(g1: &[u8], g2: &[u8], n: u64, out: &mut [u8; 576]) -> Result<(), SysError> {
    // SIMD-0388 permits at most eight pairs. Bound before converting lengths.
    if n > 8 || g1.len() < 96 * n as usize || g2.len() < 192 * n as usize {
        return Err(SysError::BadPoint);
    }
    let p1: alloc::vec::Vec<_> = g1[..96 * n as usize]
        .chunks_exact(96)
        .map(|b| {
            b.try_into()
                .map(bls::PodG1Point)
                .map_err(|_| SysError::BadPoint)
        })
        .collect::<Result<_, _>>()?;
    let p2: alloc::vec::Vec<_> = g2[..192 * n as usize]
        .chunks_exact(192)
        .map(|b| {
            b.try_into()
                .map(bls::PodG2Point)
                .map_err(|_| SysError::BadPoint)
        })
        .collect::<Result<_, _>>()?;
    *out = bls::bls12_381_pairing_map(V0, &p1, &p2, BE)
        .ok_or(SysError::BadPoint)?
        .0;
    Ok(())
}
