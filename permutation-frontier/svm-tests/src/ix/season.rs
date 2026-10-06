//! Season lifecycle builders (§5.7). W2-A's instructions are here from wave
//! 2; EndSeason, AbortSeason and CloseSeason are W4-B's (handed over with
//! this file, §11 wave 4). **MC (CQ2-A):** CreateSeason is v2 (the 352-B
//! `SeasonParams v2`, `params_hash_v2`).

use fclient::addr::Addresses;
use frontier_abi::presets::SeasonParams;
use frontier_abi::v2::presets::{
    params_hash_v2, ConquestParams, SeasonParamsV2, FRONTIER_7, SEASON_PARAMS_V2_LEN,
};
use permutation_rules::frontier::payout::PayoutParams;
use solana_address::Address;
use solana_instruction::Instruction;

/// CreateSeason v2's data after the tag (MC contract §5.2.5): `SeasonParams
/// (224 B, program_version 2) ‖ ConquestParams (128 B) ‖ PayoutParams
/// (borsh)`.
#[derive(Clone, Debug)]
pub struct Params {
    pub season: SeasonParams,
    /// The conquest block (Frontier-7 unless a test sets another).
    pub cq: ConquestParams,
    pub payout: Vec<u8>,
}

impl Params {
    /// `season` with Frontier-7's conquest block (its dormancy timers taken
    /// from `season`, which v2 validation requires equal) and the rev-3
    /// payout parameters.
    pub fn new(season: SeasonParams) -> Params {
        Params {
            season,
            cq: ConquestParams {
                dormant_after_secs: season.dormant_after_secs,
                release_after_secs: season.release_after_secs,
                ..FRONTIER_7
            },
            payout: PayoutParams::REV3.to_borsh(),
        }
    }
    /// A v2 preset (`MC_LOCAL_7D`, `MC_SEASON_28`, `MC_TEST`).
    pub fn v2(p: SeasonParamsV2) -> Params {
        Params {
            season: p.base,
            cq: p.cq,
            payout: PayoutParams::REV3.to_borsh(),
        }
    }
    pub fn v2_params(&self) -> SeasonParamsV2 {
        SeasonParamsV2 {
            base: self.season,
            cq: self.cq,
        }
    }
    pub fn season_bytes(&self) -> [u8; SEASON_PARAMS_V2_LEN] {
        self.v2_params().to_bytes()
    }
    /// The season's holding lifecycle timers (MC §3.9, §3.12) as the
    /// kernel's `LifecycleParams` (the program reads the same block).
    pub fn lifecycle(&self) -> permutation_rules::frontier::holding::LifecycleParams {
        permutation_rules::frontier::holding::LifecycleParams {
            shield_secs: self.cq.shield_secs as i64,
            shield_late_secs: self.cq.shield_late_secs as i64,
            shield_late_after_secs: self.cq.shield_late_after_secs as i64,
            dormant_after_secs: self.cq.dormant_after_secs as i64,
            release_after_secs: self.cq.release_after_secs as i64,
            outpost_shield_secs: self.cq.outpost_shield_secs as i64,
        }
    }
    /// `sha256("PSF-PARAMS-v2" ‖ SeasonParams v2 ‖ PayoutParams)` (§5.2.5).
    pub fn hash(&self) -> [u8; 32] {
        params_hash_v2(&self.season_bytes(), &self.payout)
    }
}

/// 0x08 AnnounceSeason, committing to `p`.
pub fn announce(
    a: &Addresses,
    authority: Address,
    p: &Params,
    t_create_min: i64,
    bond: u64,
) -> Instruction {
    fclient::ix::announce_season(a, authority, p.hash(), t_create_min, bond)
}

/// 0x01 CreateSeason v2 with `p` (fclient's builder takes the raw
/// parameter bytes, so the v2 block passes through unchanged).
pub fn create(a: &Addresses, authority: Address, p: &Params) -> Instruction {
    fclient::ix::create_season(a, authority, &p.season_bytes(), &p.payout)
}

pub use fclient::ix::{
    abort_season, close_season, consume_genesis_seed, end_season, init_beacon_logs, init_shards,
    set_window_schedule,
};

/// CloseSeason's shards and logs of `part` (W4-B's split: part f ∈ 0..=5
/// the faction's 8 JoinShards, part 6 the 16 BeaconLogs, part 7 the
/// Frontier, funds, pool and the Season tombstone).
pub fn close_part(a: &Addresses, authority: Address, part: u8) -> Instruction {
    let shards: Vec<(u8, u8)> = if part < 6 {
        (0..8).map(|s| (part, s)).collect()
    } else {
        vec![]
    };
    let logs: Vec<u8> = if part == 6 { (0..16).collect() } else { vec![] };
    close_season(a, authority, part, &shards, &logs)
}

/// CloseSeason's float parts (v1.8, W5-A): part 8 RingSeeds, 9
/// AnchorArchives, 10 DefenceClaims, each `(target, recipient)` pair in
/// the repeat group (the recipient is the target's stored payer, `rent_to`
/// or beneficiary). Request: the same builder in `fclient::ix` (W5-C).
pub fn close_float(
    a: &Addresses,
    authority: Address,
    part: u8,
    pairs: &[(Address, Address)],
) -> Instruction {
    let mut ix = close_season(a, authority, part, &[], &[]);
    for (t, r) in pairs {
        ix.accounts
            .push(solana_instruction::AccountMeta::new(*t, false));
        ix.accounts
            .push(solana_instruction::AccountMeta::new(*r, false));
    }
    ix
}

/// Positions of AbortSeason's accounts (§5.7).
pub mod abort_at {
    pub const ANY: usize = 0;
    pub const SEASON: usize = 1;
    pub const AUTHORITY: usize = 2;
    pub const INCINERATOR: usize = 3;
}
