//! Exact public-buffer tests only. No signing, keys, seal opening, RPC or CPI.
//! The linked host library lacks cfg(test), so its syscall adapter stays closed.
#![cfg(not(target_os = "solana"))]

#[path = "../src/crypto/pairing_contract.rs"]
mod pairing_contract;

use permutation_frontier::crypto::sys::{bls_pairing, SysError};

#[test]
fn pairing_count_is_bounded_before_length_arithmetic() {
    for n in [
        9,
        u32::MAX as u64,
        u64::MAX / 192 + 1,
        u64::MAX / 96 + 1,
        u64::MAX,
    ] {
        assert_eq!(
            pairing_contract::input_lengths(n, usize::MAX, usize::MAX),
            None
        );
        let mut out = [0xa5; 576];
        assert_eq!(bls_pairing(&[], &[], n, &mut out), Err(SysError::BadPoint));
        assert_eq!(out, [0xa5; 576]);
    }
}

#[test]
fn pairing_contract_preserves_zero_eight_and_prefix_semantics() {
    for n in 0..=8 {
        let (g1, g2) = (96 * n as usize, 192 * n as usize);
        assert_eq!(pairing_contract::input_lengths(n, g1, g2), Some((g1, g2)));
        assert_eq!(
            pairing_contract::input_lengths(n, g1 + 1, g2 + 1),
            Some((g1, g2))
        );
        if n != 0 {
            assert_eq!(pairing_contract::input_lengths(n, g1 - 1, g2), None);
            assert_eq!(pairing_contract::input_lengths(n, g1, g2 - 1), None);
        }
    }
}

#[test]
fn ordinary_host_library_remains_closed_and_failure_preserves_output() {
    for n in 0..=8 {
        let mut out = [0xa5; 576];
        assert_eq!(
            bls_pairing(&[0; 768], &[0; 1536], n, &mut out),
            Err(SysError::BadPoint)
        );
        assert_eq!(out, [0xa5; 576]);
    }
    for (g1, g2) in [(95, 192), (96, 191)] {
        let mut out = [0xa5; 576];
        assert_eq!(
            bls_pairing(&[0; 96][..g1], &[0; 192][..g2], 1, &mut out),
            Err(SysError::BadPoint)
        );
        assert_eq!(out, [0xa5; 576]);
    }
}
