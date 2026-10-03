//! ABI v2 budget placeholders and `L(kind)` sets (MC contract §5.4,
//! §13.1). **Placeholders until Gate CQ4:** CQ4-A regenerates the CU
//! limits from G1 on the MC release `.so` and `L(kind)` from its length
//! (`budgets.rs` and `vectors/budgets.json` are CQ4-A's from wave 4).
//!
//! Rows: M1's row for an instruction MC does not change; §5.4's for the
//! new and changed ones. Where §5.4 quotes a gate below M1's current one
//! (GatherClash 40k vs 49k, SkipQuiet 60k vs 90k base), the M1 value
//! stays: lowering a gate is not MC's to do (notes D-7). An unmeasured
//! row requests its gate as its limit.

use crate::budgets::{
    budget as budget_v1, legacy_tx_size, max_len_for, Budget, ACCOUNT_OVERHEAD, BUILTIN_DATA_LEN,
    COMPUTE_BUDGET_IX_DATA, CU_LADDER_MAX, LOADED_LIMIT_WORKING_DEFAULT, PROGRAM_ACCOUNT_LEN,
    TX_MAX,
};
use crate::prologue::Acc;
use crate::v2::ix::data_len_range;
use crate::v2::prologue::{accounts_of, count_bounds, kind_size_v2};
use crate::v2::tags::Ix;

/// The MC release `.so` length `L(kind)` is computed for. §5.4 estimated
/// 0.98–1.02 MB and v1.3 rounded it up to 1 MiB; the Wave-2 merge
/// (`scripts/build-frontier.sh --twice`) measured **1,132,312 B**
/// (max_len 1,417,216), so it is re-rounded to 1.125 MiB (A-33) until
/// CQ4-A regenerates the table from the MC release build of record.
pub const PLACEHOLDER_SO_LEN_V2: u32 = 1_179_648;
pub const PLACEHOLDER_PROGRAMDATA_LEN_V2: u32 = max_len_for(PLACEHOLDER_SO_LEN_V2);
/// SkipQuiet's extra CU per bell with an active record or keep contest.
pub const SKIP_PER_ACTIVE_BELL: u32 = 3_500;
/// SkipQuiet commits its prefix once `bells × active records > 288`.
pub const SKIP_RECORD_BELLS_MAX: u32 = 288;

/// One v2 row: the gate, its per-unit term, the limit to request and the
/// tx ceiling of §5.4.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BudgetV2 {
    pub ix: Ix,
    pub cu_budget: u32,
    pub cu_per_unit: u32,
    pub cu_limit: u32,
    pub tx_contract: u32,
    /// G1 measured on the MC `.so` (0 until CQ2/CQ4 measure it).
    pub measured: u32,
}

/// §5.4's rows for the new and changed instructions: `(ix, gate,
/// per-unit, tx bytes)`.
pub const MC_ROWS: &[(Ix, u32, u32, u32)] = &[
    (Ix::DeclareSiege, 30_000, 0, 640),
    (Ix::SettleSiege, 25_000, 0, 480),
    (Ix::SettleCapture, 30_000, 0, 720),
    // A-31: FileOutpost 24,000 → 28,000 (G1 measured 26,458; +5%, §5.4's rule).
    (Ix::FileOutpost, 28_000, 0, 640),
    // A-32: FoldMarch 20,000 → 36,000 (G1 measured 33,903 at §13.1's fill:
    // ≈ 15k fixed with the first fold's init + ≈ 3.2k per hour, and the
    // per-hour MARCH_FOLD log is normative; +6%).
    (Ix::FoldMarch, 36_000, 0, 720),
    (Ix::RetireHost, 17_000, 0, 480),
    (Ix::CloseMarch, 8_000, 0, 300),
    (Ix::CreateSeason, 70_000, 0, 1_100),
    (Ix::OpenRing, 30_000, 0, 600),
    (Ix::OpenProvince, 220_000, 0, 400),
    (Ix::FoldOccupancy, 30_000, 0, 1_232),
    (Ix::SettleTicket, 40_000, 0, 900),
    (Ix::ReleaseDormant, 25_000, 0, 480),
    (Ix::CloseHolding, 15_000, 0, 330),
    (Ix::Harvest, 19_000, 0, 360),
    (Ix::Build, 23_500, 0, 400),
    (Ix::Train, 19_000, 0, 360),
    (Ix::Reveal, 26_000, 0, 1_100),
    (Ix::SettleDeparture, 48_000, 0, 400),
    (Ix::SettleTransit, 85_000, 0, 1_022),
    // D-7: §5.4 quotes 40k; M1's gate is 49k (W5-A) and stays.
    (Ix::GatherClash, 49_000, 0, 1_232),
    (Ix::ResolveFromInputs, 290_000, 0, 460),
    // D-7: §5.4 quotes 60k + 30k/bell; M1's base is 90k and stays (the
    // +3.5k per active record-bell is SKIP_PER_ACTIVE_BELL).
    (Ix::SkipQuiet, 90_000, 30_000, 1_232),
    (Ix::SettleExplore, 15_000, 0, 400),
];

/// The v2 row of `ix`.
pub fn budget(ix: Ix) -> BudgetV2 {
    if let Some((_, cu, per, tx)) = MC_ROWS.iter().copied().find(|r| r.0 == ix) {
        // unmeasured: the limit is the gate (SkipQuiet: at 24 bells with
        // 12 active records each).
        let limit = if per == 0 {
            cu
        } else {
            cu + 24 * per + 24 * SKIP_PER_ACTIVE_BELL
        };
        return BudgetV2 {
            ix,
            cu_budget: cu,
            cu_per_unit: per,
            cu_limit: limit.min(CU_LADDER_MAX),
            tx_contract: tx,
            measured: 0,
        };
    }
    let b: Budget = ix.to_v1().map(budget_v1).unwrap_or(Budget {
        ix: crate::tags::Ix::CreateSeason,
        cu_budget: 0,
        cu_per_unit: 0,
        cu_limit: CU_LADDER_MAX,
        tx_contract: TX_MAX,
    });
    let measured = ix
        .to_v1()
        .and_then(|v| crate::budgets::MEASURED.iter().find(|m| m.0 == v))
        .map(|m| m.1)
        .unwrap_or(0);
    BudgetV2 {
        ix,
        cu_budget: b.cu_budget,
        cu_per_unit: b.cu_per_unit,
        cu_limit: b.cu_limit,
        tx_contract: b.tx_contract,
        measured,
    }
}

/// SkipQuiet's v2 gate for `bells` recomputed bells of which
/// `active_bells` have at least one active record or keep contest (§5.4:
/// "+ 3.5k per **bell** with an active record or keep contest"; one bell
/// with 12 records and the keep is one active bell, the lab's ≈ 263 CU per
/// record-bell × 13 fits in 3.5k). `active_bells` is capped at `bells`, so
/// the gate never exceeds `budget(SkipQuiet).cu_limit` at `bells ≤ 24`
/// (integ-W1, review CQ1-C: the third term was per record-bell, which
/// overstated it up to 13× and could exceed `CU_LADDER_MAX`).
pub fn skip_gate(bells: u32, active_bells: u32) -> u32 {
    let b = budget(Ix::SkipQuiet);
    b.cu_budget
        .saturating_add(b.cu_per_unit.saturating_mul(bells))
        .saturating_add(SKIP_PER_ACTIVE_BELL.saturating_mul(active_bells.min(bells)))
}

fn signers(ix: Ix) -> u32 {
    worst(ix).filter(|s| s.signer).count() as u32
}

fn worst(ix: Ix) -> impl Iterator<Item = crate::prologue::Spec> {
    accounts_of(ix).iter().flat_map(|g| {
        core::iter::repeat_n(g.specs, g.max as usize)
            .flatten()
            .copied()
    })
}

/// Worst-case transaction size of `ix` (every group at its maximum, the
/// longest data, the three ComputeBudget instructions).
pub fn tx_worst_estimate(ix: Ix) -> u32 {
    let (_, hi) = count_bounds(ix);
    let (_, dhi) = data_len_range(ix);
    crate::budgets::tx_size_estimate(signers(ix).max(1), hi as u32, dhi as u32)
}

/// The loaded accounts of `ix`'s worst set besides the ELF (v2 sizes).
pub fn loaded_accounts(ix: Ix) -> (u32, u8) {
    let (_, hi) = count_bounds(ix);
    let (_, data_max) = data_len_range(ix);
    let mut ixs = [(0u32, 0u32); 4];
    for (i, d) in COMPUTE_BUDGET_IX_DATA.iter().enumerate() {
        ixs[i] = (0, *d);
    }
    ixs[3] = (hi as u32, data_max as u32);
    let sysvar = crate::budgets::ix_sysvar_len(&ixs);
    let (mut bytes, mut n) = (0u32, 0u32);
    for sp in worst(ix) {
        bytes += match sp.acc {
            Acc::Wallet | Acc::Any | Acc::ProgramData => 0,
            Acc::System | Acc::Incinerator => BUILTIN_DATA_LEN,
            Acc::IxSysvar => sysvar,
            Acc::ProgramAccount => PROGRAM_ACCOUNT_LEN,
            other => kind_size_v2(other).unwrap_or(0),
        };
        n += 1;
    }
    bytes += PROGRAM_ACCOUNT_LEN + BUILTIN_DATA_LEN;
    n += 3;
    (bytes, n.min(u8::MAX as u32) as u8)
}

/// Loaded-data need of `ix`'s worst v2 set at a programdata length.
pub fn loaded_need(ix: Ix, programdata_len: u32) -> u64 {
    let (bytes, n) = loaded_accounts(ix);
    programdata_len as u64
        + crate::budgets::PROGRAMDATA_META as u64
        + bytes as u64
        + ACCOUNT_OVERHEAD as u64 * n as u64
}

/// `L(kind)` v2 at the placeholder programdata length, never below the
/// 1-MiB working default.
pub fn loaded_limit(ix: Ix) -> u32 {
    let (bytes, n) = loaded_accounts(ix);
    let l =
        permutation_rules::frontier::fees::loaded_limit(PLACEHOLDER_PROGRAMDATA_LEN_V2, bytes, n);
    l.max(LOADED_LIMIT_WORKING_DEFAULT)
}

/// The tx byte ceiling to gate on: §5.4's value, raised to the
/// worst-case estimate (rounded up to 8 B) where the table is below it
/// (M1's rule, `budgets::tx_ceiling`), never above 1,232 B.
pub fn tx_ceiling(ix: Ix) -> u32 {
    let est = tx_worst_estimate(ix).div_ceil(8) * 8;
    budget(ix).tx_contract.max(est).min(TX_MAX)
}

/// The size of a legacy transaction (re-export for vector writers).
pub fn legacy_size(n_sigs: u32, n_keys: u32, ixs: &[(u32, u32)]) -> u32 {
    legacy_tx_size(n_sigs, n_keys, ixs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_cover_every_v2_instruction() {
        for ix in Ix::ALL {
            let b = budget(*ix);
            assert!(b.cu_limit <= CU_LADDER_MAX, "{}", ix.name());
            assert!(b.tx_contract <= TX_MAX);
            if ix.is_new() {
                assert!(
                    b.cu_budget > 0 && b.cu_limit == b.cu_budget,
                    "{}",
                    ix.name()
                );
                let t = tx_worst_estimate(*ix);
                assert!(t <= tx_ceiling(*ix) && t <= TX_MAX, "{}: {t} B", ix.name());
                // §5.4's tx column is below the estimate for RetireHost
                // (two signers) and CloseMarch, as M1's was for several
                // rows: the ceiling is raised to the estimate (D-11)
                let over = matches!(*ix, Ix::RetireHost | Ix::CloseMarch);
                assert_eq!(t > b.tx_contract, over, "{}: {t} B", ix.name());
            }
            let l = loaded_limit(*ix);
            assert_eq!(l % 32_768, 0);
            assert!(loaded_need(*ix, PLACEHOLDER_PROGRAMDATA_LEN_V2) <= l as u64);
        }
        let est: std::vec::Vec<(&str, u32, u32)> = Ix::NEW
            .iter()
            .map(|i| (i.name(), tx_worst_estimate(*i), budget(*i).tx_contract))
            .collect();
        std::println!("tx estimates (name, worst, §5.4): {est:?}");
        assert_eq!(budget(Ix::ResolveFromInputs).cu_budget, 290_000);
        assert_eq!(budget(Ix::Harvest).cu_budget, 19_000);
        assert_eq!(budget(Ix::Depart).cu_budget, 24_500, "M1's row");
        // §5.4: 3.5k per active bell; 24 bells all active is the row's limit.
        assert_eq!(skip_gate(24, 24), 90_000 + 24 * 30_000 + 24 * 3_500);
        assert_eq!(skip_gate(24, 24), budget(Ix::SkipQuiet).cu_limit);
        assert_eq!(skip_gate(24, 24), 894_000);
        assert!(skip_gate(24, 24) <= CU_LADDER_MAX);
        assert_eq!(skip_gate(24, 12 * 24), skip_gate(24, 24), "capped at bells");
        assert_eq!(skip_gate(3, 0), 90_000 + 3 * 30_000);
        for n in 0..=24 {
            assert!(skip_gate(n, n) <= budget(Ix::SkipQuiet).cu_limit);
        }
        assert_eq!(PLACEHOLDER_PROGRAMDATA_LEN_V2, 1_474_560);
        // the Wave-2 release `.so` (1,132,312 B, max_len 1,417,216) fits it
        assert!(1_417_216 <= PLACEHOLDER_PROGRAMDATA_LEN_V2);
        // an MC Province loads 640 B more than an M1 one
        let v1 = crate::budgets::loaded_accounts(crate::tags::Ix::ResolveFromInputs).0;
        assert_eq!(loaded_accounts(Ix::ResolveFromInputs).0, v1 + 640);
    }
}
