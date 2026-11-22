//! The Rent sysvar (always built; `snapshot` re-exports it): its address,
//! decoding and the runtime's minimum-balance formula. The keeper's land
//! decisions take the cluster's rate from here (keeper-rent-floor), not
//! the compile-time `frontier_abi::layout::RENT_PER_BYTE`.

use solana_address::Address;

/// The runtime's per-account storage overhead counted by `minimum_balance`.
pub const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
/// The program's solana-rent 4.4 maximum account data length (10 MiB).
const MAX_RENT_DATA_LENGTH: usize = 10 * 1024 * 1024;
/// The Rent sysvar's data length.
pub const RENT_LEN: usize = 17;

/// The owner of every sysvar account.
pub fn sysvar_owner() -> Address {
    "Sysvar1111111111111111111111111111111111111"
        .parse()
        .expect("the sysvar owner is a constant")
}

/// The Rent sysvar's address.
pub fn rent_sysvar() -> Address {
    "SysvarRent111111111111111111111111111111111"
        .parse()
        .expect("the Rent sysvar address is a constant")
}

/// The Rent sysvar as the runtime serialises it: `lamports_per_byte_year
/// u64 ‖ exemption_threshold f64 ‖ burn_percent u8` (17 bytes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RentSysvar {
    pub lamports_per_byte_year: u64,
    pub exemption_threshold: f64,
    pub burn_percent: u8,
}

impl RentSysvar {
    /// Exactly 17 bytes, a finite non-negative threshold.
    pub fn decode(d: &[u8]) -> Option<RentSysvar> {
        if d.len() != RENT_LEN {
            return None;
        }
        let lamports_per_byte_year = u64::from_le_bytes(d[0..8].try_into().ok()?);
        let exemption_threshold = f64::from_le_bytes(d[8..16].try_into().ok()?);
        if !exemption_threshold.is_finite() || exemption_threshold < 0.0 {
            return None;
        }
        Some(RentSysvar {
            lamports_per_byte_year,
            exemption_threshold,
            burn_percent: d[16],
        })
    }

    pub fn encode(&self) -> [u8; RENT_LEN] {
        let mut d = [0u8; RENT_LEN];
        d[0..8].copy_from_slice(&self.lamports_per_byte_year.to_le_bytes());
        d[8..16].copy_from_slice(&self.exemption_threshold.to_le_bytes());
        d[16] = self.burn_percent;
        d
    }

    /// The **full** minimum an account of `space` bytes must hold, whatever
    /// the address already holds. Matches the program's solana-rent 4.4
    /// integer paths and global rate bounds for thresholds 1.0 and 2.0;
    /// returns `None` above the runtime's maximum account size. Other
    /// thresholds retain the conservative checked, truncated float path:
    /// overflow and non-finite/negative results refuse, never saturate.
    pub fn minimum_balance(&self, space: usize) -> Option<u64> {
        if space > MAX_RENT_DATA_LENGTH {
            return None;
        }
        let bytes = ACCOUNT_STORAGE_OVERHEAD.checked_add(u64::try_from(space).ok()?)?;
        let multiplier = if self.exemption_threshold == 1.0 {
            Some(1)
        } else if self.exemption_threshold == 2.0 {
            Some(2)
        } else {
            None
        };
        if let Some(multiplier) = multiplier {
            // The runtime validates against its largest permitted account,
            // even when this particular account's product would fit.
            let max_bytes = MAX_RENT_DATA_LENGTH as u64 + ACCOUNT_STORAGE_OVERHEAD;
            if self.lamports_per_byte_year > u64::MAX / max_bytes / multiplier {
                return None;
            }
            return bytes
                .checked_mul(self.lamports_per_byte_year)?
                .checked_mul(multiplier);
        }
        let per_year = bytes.checked_mul(self.lamports_per_byte_year)?;
        let v = per_year as f64 * self.exemption_threshold;
        if !v.is_finite() || v < 0.0 || v >= u64::MAX as f64 {
            return None;
        }
        Some(v as u64)
    }
}

#[cfg(test)]
mod rent_math_tests {
    use super::RentSysvar;

    // Literal solana-rent 4.4 limits, independent of the production constants.
    const MAX_SPACE: usize = 10_485_760;
    const MAX_RATE_ONE: u64 = 1_759_197_129_867;
    const MAX_RATE_TWO: u64 = 879_598_564_933;

    fn rent(rate: u64, threshold: f64) -> RentSysvar {
        RentSysvar {
            lamports_per_byte_year: rate,
            exemption_threshold: threshold,
            burn_percent: 50,
        }
    }

    #[test]
    fn standard_thresholds_keep_ordinary_minima() {
        for (space, expected) in [(0, 890_880), (1, 897_840), (128, 1_781_760)] {
            assert_eq!(rent(6_960, 1.0).minimum_balance(space), Some(expected));
            assert_eq!(rent(3_480, 2.0).minimum_balance(space), Some(expected));
        }
    }

    #[test]
    fn standard_thresholds_preserve_integer_precision_above_f64_range() {
        // The per-year product is odd and above 2^53. Casting it to f64
        // before applying either threshold loses a lamport (two for 2.0).
        assert_eq!(
            rent(1_073_741_825, 1.0).minimum_balance(8_388_609),
            Some(9_007_337_775_825_025)
        );
        assert_eq!(
            rent(1_073_741_825, 2.0).minimum_balance(8_388_609),
            Some(18_014_675_551_650_050)
        );
    }

    #[test]
    fn standard_thresholds_accept_exact_rate_limits_at_maximum_space() {
        for (threshold, rate, multiplier) in
            [(1.0, MAX_RATE_ONE, 1u128), (2.0, MAX_RATE_TWO, 2u128)]
        {
            for space in [0, 1, MAX_SPACE - 1, MAX_SPACE] {
                let expected = u64::try_from((space as u128 + 128) * rate as u128 * multiplier)
                    .expect("literal runtime limits fit u64");
                assert_eq!(rent(rate, threshold).minimum_balance(space), Some(expected));
                if space >= MAX_SPACE - 1 {
                    assert!(expected > i64::MAX as u64);
                }
            }
        }
    }

    #[test]
    fn standard_thresholds_reject_global_rate_overflow_even_for_empty_account() {
        for (threshold, max_rate) in [(1.0, MAX_RATE_ONE), (2.0, MAX_RATE_TWO)] {
            for rate in [max_rate + 1, u64::MAX] {
                for space in [0, 1, MAX_SPACE] {
                    assert_eq!(rent(rate, threshold).minimum_balance(space), None);
                }
            }
        }
    }

    #[test]
    fn every_threshold_rejects_oversized_accounts_even_at_zero_rate() {
        for threshold in [0.0, 0.5, 1.0, 1.5, 2.0, 3.0] {
            assert_eq!(rent(0, threshold).minimum_balance(MAX_SPACE), Some(0));
            for space in [MAX_SPACE + 1, usize::MAX] {
                assert_eq!(rent(0, threshold).minimum_balance(space), None);
                assert_eq!(rent(1, threshold).minimum_balance(space), None);
            }
        }
    }

    #[test]
    fn nonstandard_thresholds_keep_checked_truncated_float_fallback() {
        assert_eq!(rent(1, 0.5).minimum_balance(1), Some(64));
        assert_eq!(rent(1, 1.5).minimum_balance(1), Some(193));
        assert_eq!(rent(1, 0.0).minimum_balance(1), Some(0));
        assert_eq!(rent(1, -0.0).minimum_balance(1), Some(0));
        // The runtime's standard-threshold rate limits do not apply here.
        assert_eq!(
            rent(MAX_RATE_ONE + 1, 0.5).minimum_balance(0),
            Some(112_588_616_311_552)
        );
        // Keep rejecting an overflowing integer intermediate, even when a
        // zero threshold could otherwise erase it. Do not adopt saturation.
        assert_eq!(rent(u64::MAX, 0.0).minimum_balance(0), None);
        assert_eq!(rent(u64::MAX / 128, 0.5).minimum_balance(1), None);
        assert_eq!(rent(u64::MAX / 128, 3.0).minimum_balance(0), None);
        assert_eq!(rent(u64::MAX / 128, 1.5).minimum_balance(0), None);
    }

    #[test]
    fn invalid_float_results_still_refuse_without_panicking() {
        for threshold in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, f64::MAX] {
            assert_eq!(rent(1, threshold).minimum_balance(0), None);
        }
        // The existing exclusive bound also rejects a finite f64 equal to
        // 2^64, rather than relying on Rust's saturating float-to-int cast.
        assert_eq!(rent(1, (u64::MAX as f64) / 128.0).minimum_balance(0), None);
    }

    #[test]
    fn arithmetic_refusal_does_not_change_rent_wire_decoding() {
        for threshold in [1.0, 2.0] {
            let value = rent(u64::MAX, threshold);
            let encoded = value.encode();
            let decoded = RentSysvar::decode(&encoded).expect("finite Rent fields still decode");
            assert_eq!(decoded, value);
            assert_eq!(decoded.encode(), encoded);
            assert_eq!(decoded.minimum_balance(0), None);
        }
    }
}
