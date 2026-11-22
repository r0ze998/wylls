//! The cluster's rent a season ran under (rent-live-rest): what VX's and
//! VG's re-execution installs as the Rent sysvar, what V9's informational
//! pre-funded count and VR's Grant-rent rule compare with. From the input's
//! `chain.rent` (read over RPC with the final states, recorded with a
//! fixture or finals file, or declared by `--lamports-per-byte`), else the
//! local node's 5,080 ASSUMED — and the report says which
//! ([`RentBasis`]): never a silent constant.

/// The ASSUMED rate when no source states the cluster's rent:
/// `localnet::chain::LAMPORTS_PER_BYTE` (and devnet's, read 2026-11-18).
/// A model, never the season's word: [`rent_of`] labels it `assumed`.
pub const LAMPORTS_PER_BYTE: u64 = 5_080;

/// The local node's Rent sysvar at [`LAMPORTS_PER_BYTE`] (threshold 1.0,
/// burn 50 %): what a re-execution assumes when no source stated the rent.
pub fn assumed_rent() -> fclient::rent::RentSysvar {
    fclient::rent::RentSysvar {
        lamports_per_byte_year: LAMPORTS_PER_BYTE,
        exemption_threshold: 1.0,
        burn_percent: 50,
    }
}

/// Lamports per byte a Rent sysvar charges (`minimum_balance(0) / 128`),
/// `None` when it is no whole rate (a threshold other than 1.0 or 2.0).
pub fn rent_per_byte(r: &fclient::rent::RentSysvar) -> Option<u64> {
    let m = r.minimum_balance(0)?;
    (m % fclient::rent::ACCOUNT_STORAGE_OVERHEAD == 0)
        .then_some(m / fclient::rent::ACCOUNT_STORAGE_OVERHEAD)
}

/// Where the rent a re-execution uses came from (rent-live-rest).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RentBasis {
    /// The cluster's Rent sysvar, read with the final states (RPC) or
    /// recorded with the input (a fixture's or a finals file's `rent`).
    Chain,
    /// Stated by the operator (`--lamports-per-byte`).
    Declared,
    /// No source stated it: the local node's default ([`assumed_rent`]).
    Assumed,
}

impl RentBasis {
    pub fn name(self) -> &'static str {
        match self {
            RentBasis::Chain => "chain",
            RentBasis::Declared => "declared",
            RentBasis::Assumed => "assumed",
        }
    }
}

/// The Rent sysvar a re-execution of `input` installs, and its basis: the
/// input's `chain.rent` (decoded strictly), else the ASSUMED default.
pub fn rent_of(input: &crate::input::Input) -> (fclient::rent::RentSysvar, RentBasis) {
    match input
        .chain
        .rent
        .as_ref()
        .and_then(|r| r.sysvar().map(|s| (s, r)))
    {
        Some((s, r)) if r.declared => (s, RentBasis::Declared),
        Some((s, _)) => (s, RentBasis::Chain),
        None => (assumed_rent(), RentBasis::Assumed),
    }
}

/// The rent-exempt minimum of `space` data bytes under the season's rent
/// ([`rent_of`]: the chain's, declared, or the assumed 5,080).
pub fn rent_for(input: &crate::input::Input, space: usize) -> u64 {
    rent_of(input)
        .0
        .minimum_balance(space)
        .unwrap_or_else(|| frontier_abi::layout::rent(space))
}
