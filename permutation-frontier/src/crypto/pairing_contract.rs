//! Buffer contract shared by the Solana syscall and native test adapters.
//! SIMD-0388 / pinned solana-bls12-381-syscall 0.1.1 allows 0..=8 pairs.
//! Validate the count before narrowing or multiplying it: caller-controlled
//! u64 counts must never wrap into a shorter memory range at the FFI boundary.
pub(super) fn input_lengths(n: u64, g1_len: usize, g2_len: usize) -> Option<(usize, usize)> {
    if n > 8 {
        return None;
    }
    let count = usize::try_from(n).ok()?;
    let g1_needed = 96usize.checked_mul(count)?;
    let g2_needed = 192usize.checked_mul(count)?;
    if g1_len < g1_needed || g2_len < g2_needed {
        return None;
    }
    Some((g1_needed, g2_needed))
}
